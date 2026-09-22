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
		//#region src/client/settings-scope.ts
		const MEMORY_STATUS = "unavailable";
		/**
		* Backoff before re-reading a directory whose FIRST read failed, in millis.
		*
		* A first read can lose to a Host that is still coming up (the gateway's WS
		* handshake, a settings service mid-start): the failure is transient, but the
		* scope has nothing held, so it keeps its initial `{ status: 'loading',
		* writable: false }` snapshot — and every control on the settings page renders
		* disabled behind a "read-only" banner. Nothing else would ever re-read it:
		* the forwarded `settings/document-updated` and `connection/reset` signals need
		* a live Host to fire, and the namespace only re-mounts on a page reload. So a
		* failure with NOTHING held retries on this bounded ladder; a failure with a
		* held view keeps it (no retry — the page is already showing the last good
		* document, and `tests/settings-scope.test.ts` pins that).
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
			persistence;
			inFlight;
			rerun = false;
			generation = 0;
			/** Pending retry handle and how many of {@link SETTINGS_DESCRIBE_RETRY_MS} are spent. */
			retryHandle;
			retries = 0;
			disposed = false;
			/**
			* @param resolveRemote - Reads the inject-captured `remote.settings` namespace.
			* @param persistence - Client-selected Host persistence; non-loopback pages may stay process-local.
			* @param timer - Retry timer seam (see {@link SETTINGS_DESCRIBE_RETRY_MS}).
			*/
			constructor(resolveRemote, persistence, timer = REAL_SETTINGS_TIMER) {
				this.resolveRemote = resolveRemote;
				this.timer = timer;
				this.persistence = persistence;
				this.store = createSnapshotStore({
					status: persistence === "host" ? "idle" : MEMORY_STATUS,
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
			/** The cheap idempotent entry: kick a first read (a no-op on memory persistence). */
			ensure() {
				this.load();
			}
			/**
			* Refresh from the Host. A call during an in-flight read marks one rerun
			* after it settles instead of racing a second wire read.
			* @returns settlement after this call's freshness is reflected.
			*/
			load() {
				if (this.disposed || this.persistence === "memory") return Promise.resolve();
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
							outcome = { failure: error instanceof Error ? error.message : String(error) };
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
		* Host writes. This is the face `CommandCodeSettingsController` consumes
		* (`getSnapshot` / `subscribe` / `set` / `unset`), so the controller itself
		* needs no changes for either generation.
		*/
		var RemoteSettingsScope = class {
			resolveRemote;
			store;
			mirror;
			namespace;
			persistence;
			tail = Promise.resolve();
			writeGeneration = 0;
			disposed = false;
			unsubscribe;
			/** Revision answered by a superseded write still ahead of the mirror. */
			pendingRevision;
			constructor(resolveRemote, mirror, namespace, persistence) {
				this.resolveRemote = resolveRemote;
				this.mirror = mirror;
				this.namespace = namespace;
				this.persistence = persistence;
				this.store = createSnapshotStore({
					status: persistence === "host" ? "loading" : "unavailable",
					value: void 0,
					base: void 0,
					user: void 0,
					revision: void 0,
					writable: false,
					mode: persistence
				});
				if (persistence === "host") {
					this.unsubscribe = mirror.subscribe(() => {
						this.derive();
					});
					this.derive();
				}
			}
			getSnapshot() {
				return this.store.getSnapshot();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			/** Queue one field write (the single-path `set` op form). */
			set(field, value) {
				return this.mutate([{
					op: "set",
					path: [field],
					value
				}]);
			}
			/** Queue one field clear (the single-path `unset` op form). */
			unset(field) {
				return this.mutate([{
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
						return;
					}
					if (this.disposed) return;
					const row = response.value;
					if (generation === this.writeGeneration) {
						this.pendingRevision = void 0;
						this.mirror.acceptView(row);
					} else this.pendingRevision = typeof row.revision === "number" ? row.revision : void 0;
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
						error: { message: error instanceof Error ? error.message : String(error) }
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
			/** Queue operations one at a time; memory persistence and disposal are no-ops. */
			enqueue(operation) {
				if (this.persistence === "memory" || this.disposed) return Promise.resolve();
				const task = this.tail.then(async () => {
					if (this.disposed) return;
					await operation();
				});
				this.tail = task.catch(() => {});
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
		* `connection/reset` — kicks the first describe read, and derives the
		* namespace row on every mirror change.
		*
		* `resolveRemote` is the INJECT-CAPTURED namespace (see
		* {@link SettingsRemoteResolver}): `remote.settings` is a Cordis service nested
		* under `remote`, so a read through our own context throws and has to be
		* replaced by an object captured inside `ctx.inject(['remote.settings'], …)`.
		* The caller that owns that inject calls {@link ManagedSettingsScope.refresh}
		* once the namespace lands, which is what turns the first, namespace-less read
		* into a served one; a profile that never mounts the namespace leaves the page
		* in its degraded (`unavailable`, read-only) state instead of throwing.
		*
		* @param context - The client context slice (only the declared `remote` service is read).
		* @param namespace - Settings namespace (profile entry id) this scope binds.
		* @param resolveRemote - Reads the inject-captured `remote.settings` namespace.
		* @returns The scope plus the refresh/dispose handles the entry wires into its fiber.
		*/
		function createSettingsScope(context, namespace, resolveRemote, timer = REAL_SETTINGS_TIMER) {
			const loopback = context.remote.$host?.isLoopback === true;
			const persistence = loopback ? "host" : "memory";
			const mirror = new SettingsDescribeMirror(resolveRemote, persistence, timer);
			const scope = new RemoteSettingsScope(resolveRemote, mirror, namespace, persistence);
			const disposers = [];
			if (loopback) {
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
			}
			return {
				getSnapshot: () => scope.getSnapshot(),
				subscribe: (listener) => scope.subscribe(listener),
				set: (field, value) => scope.set(field, value),
				unset: (field) => scope.unset(field),
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
		//#region src/client/settings.ts
		/**
		* Browser controller for the "Command Code" settings page.
		*
		* The page lives at the same settings-nav level as General / Models / Plugins
		* (a `settings.section` entry, id `commandcode`). It exists because the
		* Models page renders an unknown-adapter-family card for the `commandcode`
		* provider and deliberately disables its submit — the API key cannot be
		* configured there. This page owns the connection facts the plugin resolves
		* per request:
		*
		*   - API key   -> written through the credentials domain under the reference
		*                  the plugin resolves (`apiKeyEnv`, default
		*                  `COMMANDCODE_API_KEY`). The literal never rides a response,
		*                  so the control only reports whether one is configured.
		*   - API base  -> the `llm-commandcode` settings namespace (`apiBase`), same
		*                  namespace the Models page card addresses.
		*   - Working dir, request/stream timeouts -> the same namespace.
		*
		* The controller mirrors the plugin-card pattern from the harness's own
		* settings UI: it binds the `llm-commandcode` namespace through a
		* `SettingsScope` — this plugin's own binding of `remote.settings` (see
		* `./settings-scope.ts`; the harness's `settingsScope` wrapper existed only
		* through 0.1.6 and was removed with the 0.1.7 settings rewrite, while the
		* wire underneath spans every supported release) — keeps a staged draft of
		* edits, and writes them on save through `scope.set` / the credentials
		* domain. The Host stays the single fact source; the snapshot is republished
		* after each accepted write.
		*
		* This module is deliberately free of JSX — it only produces the state face
		* the React component renders.
		*/
		/** The settings namespace the plugin registers (host half, src/index.ts). */
		const COMMANDCODE_NS = "llm-commandcode";
		/** Default credential reference the plugin resolves when none is named. */
		const DEFAULT_API_KEY_REF = "COMMANDCODE_API_KEY";
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
		* Decimals pass: the Host schema is `z.number()` too, and a fractional
		* millisecond value is harmless even if pointless.
		*/
		function numberField$1(field, bounds) {
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
		const MAX_TIMEOUT_MS = 2147483647;
		/** The fields this page edits inside the `llm-commandcode` namespace. */
		const SECTION_FIELDS = [
			textField("apiBase"),
			textField("workingDir"),
			numberField$1("requestTimeoutMs", {
				min: 1,
				max: MAX_TIMEOUT_MS
			}),
			numberField$1("streamIdleTimeoutMs", {
				min: 1,
				max: MAX_TIMEOUT_MS
			}),
			numberField$1("transportMaxRetries", {
				min: 0,
				max: 50
			}),
			booleanField$1("filterModelsByPlan"),
			booleanField$1("webSearch"),
			booleanField$1("showSidebarQuota"),
			textField("activeAccount")
		];
		/** Whether two model-id lists are equal as sets (order-insensitive). */
		function sameModels(a, b) {
			if (a.length !== b.length) return false;
			const set = new Set(a);
			return b.every((id) => set.has(id));
		}
		/**
		* Order-sensitive content fingerprint of the stored routing rules. Stored rule
		* ids are positional (`rule-<index>`), so equality of this fingerprint across a
		* save is exactly the statement "no rules write landed and no row shifted".
		*/
		function ruleFingerprint(rules) {
			return JSON.stringify(rules.map((rule) => [rule.models, rule.account]));
		}
		/**
		* Controller bridging the `llm-commandcode` scope and the credentials domain
		* onto the page. Public API mirrors the harness's CardForm actions, so the
		* component stays thin.
		*/
		var CommandCodeSettingsController = class {
			scope;
			api;
			specs = new Map(SECTION_FIELDS.map((spec) => [spec.field, spec]));
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			disposers = [];
			disposed = false;
			defaultWorkingDir;
			/** The credential reference the default account resolves. */
			credentialRef = DEFAULT_API_KEY_REF;
			/** Host-reported configured/writable state per credential reference. */
			credentialStates = /* @__PURE__ */ new Map();
			/** Staged account additions (not yet saved). */
			addedAccounts = [];
			/** Staged removals of stored extra accounts, by credential reference. */
			removedRefs = /* @__PURE__ */ new Set();
			/** Staged label drafts, by credential reference. */
			labelDrafts = /* @__PURE__ */ new Map();
			/** Staged key drafts, by credential reference (blank = keep stored key). */
			keyDrafts = /* @__PURE__ */ new Map();
			/** Credential references staged for removal on the next save. */
			keyClears = /* @__PURE__ */ new Set();
			/** Staged model→account routing rules (not yet saved). */
			addedRules = [];
			/** Staged edits to stored routing rules, by stored row id. */
			ruleDrafts = /* @__PURE__ */ new Map();
			/**
			* Stored routing rule rows staged for removal, by stored row id with a
			* content snapshot. The snapshot makes reconcile content-based: stored
			* row ids are positional (`rule-N`) and shift after any write, so an
			* id-only check would misread a landed removal as pending (and a retry
			* would delete the wrong row).
			*/
			removedRuleIds = /* @__PURE__ */ new Map();
			/**
			* Fingerprint of the stored routing rules when the last `save()` started;
			* `undefined` outside a save. Lets reconcile distinguish a landed rules
			* write from a save that failed before reaching it.
			*/
			rulesBeforeSave = void 0;
			/** Staged visible-model allowlist (undefined = no draft). */
			visibleModelsDraft = void 0;
			/** The catalog the model editors offer (Host-side). */
			catalogModels = [];
			catalogFailed = false;
			saving = false;
			failed = false;
			savedCount = 0;
			/**
			* @param scope - bound scope for the `llm-commandcode` namespace.
			* @param api - credentials wire face.
			* @param hostDescription - the Host-description observable whose `cwd` is
			*   shown as the placeholder a blank `workingDir` field resolves to.
			*/
			constructor(scope, api, hostDescription) {
				this.scope = scope;
				this.api = api;
				this.disposers.push(scope.subscribe(() => {
					this.recomputeCredentialRef();
					this.describeAll();
					this.publish();
				}));
				if (hostDescription !== void 0) {
					this.defaultWorkingDir = hostDescription.getSnapshot()?.cwd;
					this.disposers.push(hostDescription.subscribe(() => {
						if (this.disposed) return;
						const cwd = hostDescription.getSnapshot()?.cwd;
						if (cwd !== this.defaultWorkingDir) {
							this.defaultWorkingDir = cwd;
							this.publish();
						}
					}));
				}
				this.recomputeCredentialRef();
				this.describeAll();
				this.refreshCatalog();
			}
			/** Release every subscription held on external sources. Idempotent. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				for (const dispose of this.disposers) dispose();
				this.disposers.length = 0;
				this.listeners.clear();
			}
			/**
			* The credential reference the section names, or the provider default. A
			* user who renamed `apiKeyEnv` in `settings.yaml` (or the composition
			* config) gets a page that addresses the renamed ref instead of silently
			* writing the default — mirroring the Models page's `refFor()`.
			*/
			recomputeCredentialRef() {
				const snapshot = this.scope.getSnapshot();
				const named = typeof snapshot.value?.apiKeyEnv === "string" && snapshot.value.apiKeyEnv.length > 0 ? snapshot.value.apiKeyEnv : DEFAULT_API_KEY_REF;
				if (named === this.credentialRef) return;
				this.credentialStates.delete(this.credentialRef);
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
				const credential = this.credentialStates.get(this.credentialRef);
				const accounts = this.effectiveAccounts();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					apiKeyConfigured: credential?.configured ?? false,
					anyAccountConfigured: (credential?.configured ?? false) || accounts.some((account) => account.configured),
					apiKeyWritable: credential?.writable ?? true,
					apiKey: {
						text: this.staged.get("apiKey")?.text ?? "",
						clear: false,
						overridden: false,
						invalid: false,
						invalidReason: void 0
					},
					apiKeyClearStaged: this.keyClears.has(this.credentialRef),
					apiBase: this.field("apiBase"),
					workingDir: this.field("workingDir"),
					defaultWorkingDir: this.defaultWorkingDir,
					requestTimeoutMs: this.field("requestTimeoutMs"),
					streamIdleTimeoutMs: this.field("streamIdleTimeoutMs"),
					transportMaxRetries: this.field("transportMaxRetries"),
					filterModelsByPlan: this.field("filterModelsByPlan"),
					webSearch: this.field("webSearch"),
					showSidebarQuota: this.field("showSidebarQuota"),
					sidebarQuota: this.sectionValue("showSidebarQuota") === true,
					activeAccount: this.field("activeAccount"),
					accounts,
					accountsRemoving: [...this.removedRefs],
					rules: this.effectiveRules(),
					visibleModels: this.effectiveVisibleModels(),
					catalogModels: this.catalogModels,
					catalogFailed: this.catalogFailed,
					dirty: plan.length > 0 || this.accountsDirty() || this.rulesDirty() || this.visibleModelsDirty(),
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed,
					savedCount: this.savedCount
				};
			}
			/** Stage a new extra account (saved on the next `save()`). */
			addAccount() {
				const used = /* @__PURE__ */ new Set([
					this.credentialRef,
					...this.storedExtras().map((extra) => extra.ref),
					...this.addedAccounts.map((extra) => extra.ref)
				]);
				let n = 2;
				while (used.has(`${this.credentialRef}_${n}`)) n += 1;
				const index = this.storedExtras().length + this.addedAccounts.length + 2;
				this.addedAccounts.push({
					label: `Account ${index}`,
					ref: `${this.credentialRef}_${n}`
				});
				this.failed = false;
				this.describeAll();
				this.publish();
			}
			/** Stage one extra account's removal (or drop an unsaved addition). */
			removeAccount(id) {
				const addedIndex = this.addedAccounts.findIndex((extra) => extra.ref === id);
				if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1);
				else this.removedRefs.add(id);
				this.labelDrafts.delete(id);
				this.keyDrafts.delete(id);
				const stagedActive = this.staged.get("activeAccount");
				if ((stagedActive !== void 0 ? stagedActive.clear ? "" : stagedActive.text : typeof this.sectionValue("activeAccount") === "string" ? this.sectionValue("activeAccount") : "") === id) this.staged.set("activeAccount", {
					text: "",
					clear: true
				});
				this.failed = false;
				this.publish();
			}
			/** Stage one extra account's label draft. */
			editAccountLabel(id, text) {
				this.labelDrafts.set(id, text);
				this.failed = false;
				this.publish();
			}
			/** Stage one extra account's key draft (blank keeps the stored key). */
			editAccountKey(id, text) {
				this.keyDrafts.set(id, text);
				this.keyClears.delete(id);
				this.failed = false;
				this.publish();
			}
			/**
			* Toggle the staged removal of one account's stored key: the next save
			* unsets the credential so the account reports unconfigured and falls back
			* to its other key sources. Only meaningful while a key is actually
			* stored. `target` is `'default'` (the implicit first account) or an extra
			* account's credential reference.
			*/
			toggleKeyClear(target) {
				const ref = target === "default" ? this.credentialRef : target;
				if (this.keyClears.has(ref)) this.keyClears.delete(ref);
				else {
					if (this.credentialStates.get(ref)?.configured !== true) return;
					this.keyDrafts.delete(ref);
					if (ref === this.credentialRef) this.staged.delete("apiKey");
					this.keyClears.add(ref);
				}
				this.failed = false;
				this.describeAll();
				this.publish();
			}
			/** Stage a new model → account routing rule (saved on the next `save()`). */
			addRule() {
				this.addedRules.push({
					models: [],
					account: "default"
				});
				this.failed = false;
				this.publish();
			}
			/** Stage one routing rule's removal (or drop an unsaved addition). */
			removeRule(id) {
				const addedIndex = this.addedRules.findIndex((_, index) => `new-${index}` === id);
				if (addedIndex >= 0) this.addedRules.splice(addedIndex, 1);
				else {
					const stored = this.storedRules().find((rule) => rule.id === id);
					this.removedRuleIds.set(id, stored === void 0 ? {
						models: [],
						account: ""
					} : {
						models: [...stored.models],
						account: stored.account
					});
				}
				this.ruleDrafts.delete(id);
				this.failed = false;
				this.publish();
			}
			/** Stage one routing rule's selected model ids (multi-select). */
			editRuleModels(id, models) {
				const addedIndex = this.addedRules.findIndex((_, index) => `new-${index}` === id);
				if (addedIndex >= 0) this.addedRules[addedIndex] = {
					...this.addedRules[addedIndex],
					models
				};
				else {
					const current = this.ruleDrafts.get(id) ?? this.storedRules().find((rule) => rule.id === id) ?? {
						models: [],
						account: "default"
					};
					this.ruleDrafts.set(id, {
						...current,
						models
					});
				}
				this.failed = false;
				this.publish();
			}
			/** Stage one routing rule's target account draft. */
			editRuleAccount(id, text) {
				const addedIndex = this.addedRules.findIndex((_, index) => `new-${index}` === id);
				if (addedIndex >= 0) this.addedRules[addedIndex] = {
					...this.addedRules[addedIndex],
					account: text
				};
				else {
					const current = this.ruleDrafts.get(id) ?? this.storedRules().find((rule) => rule.id === id) ?? {
						models: [],
						account: "default"
					};
					this.ruleDrafts.set(id, {
						...current,
						account: text
					});
				}
				this.failed = false;
				this.publish();
			}
			/** Stage one field's draft text. */
			edit(field, text) {
				this.staged.set(field, {
					text,
					clear: false
				});
				if (field === "apiKey") this.keyClears.delete(this.credentialRef);
				this.failed = false;
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
				this.publish();
			}
			/** Discard every staged edit. */
			discard() {
				if (this.staged.size === 0 && !this.accountsStaged() && !this.rulesStaged() && !this.visibleModelsStaged() && !this.failed) return;
				this.staged.clear();
				this.clearAccountStaging();
				this.clearRuleStaging();
				this.clearVisibleModelsStaging();
				this.failed = false;
				this.publish();
			}
			/**
			* Re-read the Host's credential facts without any staged edit. The browser
			* login stores a key Host-side behind the page's back; the plugin entry
			* calls this when a login lands so the configured/writable badges follow.
			*/
			refreshCredentials() {
				this.describeAll();
			}
			/** Write every staged edit, then re-read the Host's accepted state. */
			async save() {
				const plan = this.plan();
				const accountRuns = this.accountPlan();
				const ruleRuns = this.rulesPlan();
				const visibleRuns = this.visibleModelsPlan();
				if (plan.length === 0 && accountRuns.length === 0 && ruleRuns.length === 0 && visibleRuns.length === 0 || this.saving) return;
				const runs = [];
				for (const item of plan) {
					if (item.run === void 0) return;
					runs.push(item.run);
				}
				this.saving = true;
				this.failed = false;
				this.rulesBeforeSave = ruleFingerprint(this.storedRules());
				this.publish();
				let landed = true;
				for (const run of [
					...runs,
					...accountRuns,
					...ruleRuns,
					...visibleRuns
				]) {
					let ok = false;
					try {
						ok = await run();
					} catch {
						ok = false;
					}
					if (!ok) {
						landed = false;
						break;
					}
				}
				this.saving = false;
				this.failed = !landed;
				if (landed) {
					this.savedCount += 1;
					this.staged.clear();
					this.clearAccountStaging();
					this.clearRuleStaging();
					this.clearVisibleModelsStaging();
				} else {
					this.reconcileAccountStaging();
					this.reconcileRuleStaging();
					this.reconcileVisibleModelsStaging();
				}
				this.publish();
			}
			/**
			* Drop account staging the stored section already reflects: additions whose
			* ref is now stored, removals whose ref is gone, and label drafts that the
			* stored label proves landed. Key drafts are kept — a landed key write is
			* idempotent on retry, and the draft carries the user's intent when it was
			* the accounts write that failed.
			*/
			reconcileAccountStaging() {
				const stored = new Set(this.storedExtras().map((extra) => extra.ref));
				this.addedAccounts = this.addedAccounts.filter((extra) => !stored.has(extra.ref));
				for (const ref of [...this.removedRefs]) if (!stored.has(ref)) this.removedRefs.delete(ref);
				for (const [ref, text] of [...this.labelDrafts]) {
					const storedLabel = this.storedExtras().find((extra) => extra.ref === ref)?.label;
					if (storedLabel !== void 0 && storedLabel === text.trim()) this.labelDrafts.delete(ref);
				}
				for (const ref of [...this.keyClears]) if (this.credentialStates.get(ref)?.configured !== true) this.keyClears.delete(ref);
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
			/**
			* The writes a save would perform, in staged order. A field whose draft is
			* not a value its spec accepts carries no write (the save refuses).
			*/
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					if (field === "apiKey") {
						const value = staged.text.trim();
						if (value !== "") plan.push({
							field,
							run: () => this.writeKey(value)
						});
						continue;
					}
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({
							field,
							run: () => this.clear(field)
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const parsed = spec.parse(staged.text);
					if (parsed.kind === "invalid") plan.push({
						field,
						run: void 0
					});
					else if (parsed.kind === "clear") plan.push({
						field,
						run: () => this.clear(field)
					});
					else plan.push({
						field,
						run: () => this.store(field, parsed.value)
					});
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer()?.[field] === value;
			}
			/** Write the staged default key, then re-read whether the Host holds it. */
			async writeKey(value) {
				return this.writeKeyTo(this.credentialRef, value);
			}
			/** Write one account's key, then re-read the Host's credential states. */
			async writeKeyTo(ref, value) {
				try {
					if (!(await this.api.credentials.set(ref, value)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(ref)?.configured ?? false;
			}
			/** Ask the credentials domain about every reference this page writes. */
			async describeAll() {
				const refs = [
					this.credentialRef,
					...this.storedExtras().map((extra) => extra.ref),
					...this.addedAccounts.map((extra) => extra.ref)
				];
				let response;
				try {
					response = await this.api.credentials.describe(refs);
				} catch {
					return;
				}
				if (!response.ok) return;
				let changed = false;
				for (const ref of refs) {
					const view = response.value?.[ref];
					const next = {
						configured: view?.configured ?? false,
						writable: view?.writable ?? true
					};
					const prev = this.credentialStates.get(ref);
					if (prev === void 0 || prev.configured !== next.configured || prev.writable !== next.writable) {
						this.credentialStates.set(ref, next);
						changed = true;
					}
				}
				if (changed) this.publish();
			}
			/**
			* Fetch the model catalog for the settings page's model editors through
			* the Host Remote. Runs once at construction; call again (e.g. from the
			* client entry once the Remote mount lands) to (re)try — a later success
			* clears a prior failure flag so the editors recover without a page reload.
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
								...typeof entry.tier === "string" ? { tier: entry.tier } : {}
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
			* The stored extra accounts from the settings section (`accounts`): the rows
			* this page can address, i.e. the ones carrying a credential reference.
			*
			* Entries the page cannot name are deliberately NOT listed here but are also
			* never dropped — `writeAccounts()` rebuilds the stored list from
			* {@link rawStoredAccounts} and only rewrites the reference-carrying entries
			* it manages (see the note there), so a literal-key entry stays in the
			* document and simply has no row.
			*/
			storedExtras() {
				const out = [];
				for (const record of this.rawStoredAccounts()) {
					const ref = record.apiKeyEnv;
					if (typeof ref !== "string" || ref === "") continue;
					const label = record.label;
					out.push({
						label: typeof label === "string" && label !== "" ? label : ref,
						ref
					});
				}
				return out;
			}
			/** Every extra account row: stored (minus staged removals) + staged adds. */
			effectiveAccounts() {
				const stored = this.storedExtras().filter((extra) => !this.removedRefs.has(extra.ref)).map((extra) => ({
					...extra,
					added: false
				}));
				const added = this.addedAccounts.map((extra) => ({
					...extra,
					added: true
				}));
				return [...stored, ...added].map((extra) => ({
					id: extra.ref,
					ref: extra.ref,
					label: this.labelDrafts.get(extra.ref) ?? extra.label,
					keyText: this.keyDrafts.get(extra.ref) ?? "",
					configured: this.credentialStates.get(extra.ref)?.configured ?? false,
					writable: this.credentialStates.get(extra.ref)?.writable ?? true,
					added: extra.added,
					clearStaged: this.keyClears.has(extra.ref)
				}));
			}
			/** Whether any account-level staging (add/remove/label/key/clear) exists. */
			accountsStaged() {
				return this.addedAccounts.length > 0 || this.removedRefs.size > 0 || this.labelDrafts.size > 0 || this.keyDrafts.size > 0 || this.keyClears.size > 0;
			}
			/** Whether the staged account edits differ from the stored section. */
			accountsDirty() {
				if (this.addedAccounts.length > 0 || this.removedRefs.size > 0) return true;
				for (const [ref, text] of this.labelDrafts) {
					const base = this.storedExtras().find((extra) => extra.ref === ref)?.label;
					if (base !== void 0 && text.trim() !== "" && text !== base) return true;
				}
				for (const text of this.keyDrafts.values()) if (text.trim() !== "") return true;
				for (const ref of this.keyClears) if (this.credentialStates.get(ref)?.configured === true) return true;
				return false;
			}
			/** Reset every account-level staged edit. */
			clearAccountStaging() {
				this.addedAccounts = [];
				this.removedRefs.clear();
				this.labelDrafts.clear();
				this.keyDrafts.clear();
				this.keyClears.clear();
			}
			/** Unset one stored credential, then re-read the Host's credential states. */
			async unsetKey(ref) {
				try {
					if (!(await this.api.credentials.unset(ref)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(ref)?.configured !== true;
			}
			/** The account-level writes a save performs (empty when nothing staged). */
			accountPlan() {
				if (!this.accountsDirty()) return [];
				const runs = [];
				for (const ref of this.keyClears) if (this.credentialStates.get(ref)?.configured === true) runs.push(() => this.unsetKey(ref));
				for (const [ref, text] of this.keyDrafts) {
					const value = text.trim();
					if (value !== "" && !this.removedRefs.has(ref) && !this.keyClears.has(ref)) runs.push(() => this.writeKeyTo(ref, value));
				}
				runs.push(() => this.writeAccounts());
				return runs;
			}
			/**
			* Persist the staged accounts list into the settings section.
			*
			* The stored list is the base — NOT a list rebuilt from this page's rows.
			* A composition-config entry may carry a literal `apiKey` (or a shape this
			* page does not know), and the settings layer replaces the whole array, so a
			* rebuilt list would silently delete every entry the page cannot name along
			* with the literal keys of the entries it can. Entries are therefore carried
			* over verbatim and only the reference-carrying rows are rewritten (label
			* draft applied, staged removals dropped, staged additions appended).
			*/
			async writeAccounts() {
				const removed = this.removedRefs;
				const written = /* @__PURE__ */ new Set();
				const list = [];
				for (const entry of this.rawStoredAccounts()) {
					const ref = entry.apiKeyEnv;
					if (typeof ref !== "string" || ref === "") {
						list.push({ ...entry });
						continue;
					}
					if (removed.has(ref) || written.has(ref)) continue;
					written.add(ref);
					list.push(this.accountEntry(ref, entry));
				}
				for (const extra of this.addedAccounts) {
					if (written.has(extra.ref)) continue;
					written.add(extra.ref);
					list.push(this.accountEntry(extra.ref, extra));
				}
				await this.scope.set("accounts", list);
				const after = this.rawStoredAccounts();
				return after.length === list.length && list.every((item, index) => after[index]?.apiKeyEnv === item.apiKeyEnv);
			}
			/**
			* One written account entry: the stored/added facts plus the label draft.
			* `fallback` contributes the non-managed fields (a stored entry's literal
			* `apiKey`, or any future field) so a rewrite never strips them.
			*/
			accountEntry(ref, fallback) {
				const draft = this.labelDrafts.get(ref)?.trim();
				const base = "ref" in fallback ? { label: fallback.label } : { ...fallback };
				const storedLabel = base.label;
				return {
					...base,
					label: draft !== void 0 && draft !== "" ? draft : typeof storedLabel === "string" && storedLabel !== "" ? storedLabel : ref,
					apiKeyEnv: ref
				};
			}
			/** The stored routing rules from the settings section (`modelAccountRules`). */
			storedRules() {
				const raw = this.scope.getSnapshot().value?.modelAccountRules;
				if (!Array.isArray(raw)) return [];
				const out = [];
				for (const [index, entry] of raw.entries()) {
					if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
					const record = entry;
					const models = record.models;
					const account = record.account;
					const modelsList = Array.isArray(models) && models.every((m) => typeof m === "string") ? models.filter((m) => m !== "") : [];
					if (modelsList.length === 0) continue;
					out.push({
						id: `rule-${index}`,
						models: modelsList,
						account: typeof account === "string" && account !== "" ? account : "default"
					});
				}
				return out;
			}
			/** Every routing rule row: stored (minus staged removals, with drafts) + staged adds. */
			effectiveRules() {
				const stored = this.storedRules().filter((rule) => !this.removedRuleIds.has(rule.id)).map((rule) => {
					const draft = this.ruleDrafts.get(rule.id);
					return {
						id: rule.id,
						models: draft?.models ?? rule.models,
						account: draft?.account ?? rule.account,
						added: false
					};
				});
				const added = this.addedRules.map((rule, index) => ({
					id: `new-${index}`,
					models: rule.models,
					account: rule.account,
					added: true
				}));
				return [...stored, ...added];
			}
			/** Whether any routing-rule staging (add/remove/edit) exists. */
			rulesStaged() {
				return this.addedRules.length > 0 || this.removedRuleIds.size > 0 || this.ruleDrafts.size > 0;
			}
			/** Whether the staged routing rules differ from the stored section. */
			rulesDirty() {
				if (this.addedRules.length > 0 || this.removedRuleIds.size > 0) return true;
				for (const [id, draft] of this.ruleDrafts) {
					const base = this.storedRules().find((rule) => rule.id === id);
					if (base === void 0) continue;
					if (draft.models.length > 0 && !sameModels(draft.models, base.models)) return true;
					if (draft.account !== base.account) return true;
				}
				return false;
			}
			/** Reset every routing-rule staged edit. */
			clearRuleStaging() {
				this.addedRules = [];
				this.ruleDrafts.clear();
				this.removedRuleIds.clear();
			}
			/**
			* Drop rule staging the stored section already reflects (partial-save
			* retry). Stored row ids are positional (`rule-N`) and shift after any
			* write, so every check here is content-based, never id-based:
			* - landed additions (in `addedRules`, already in stored) are dropped, or
			*   a retry would persist them twice;
			* - staged removals whose snapshot row is gone from stored have landed
			*   (drop them); a removal whose snapshot still matches a stored row is
			*   still pending (keep it).
			*/
			reconcileRuleStaging() {
				const stored = this.storedRules();
				this.addedRules = this.addedRules.filter((added) => !stored.some((rule) => sameModels(added.models, rule.models) && added.account === rule.account));
				for (const [id, snapshot] of [...this.removedRuleIds]) if (!stored.some((rule) => sameModels(snapshot.models, rule.models) && snapshot.account === rule.account)) this.removedRuleIds.delete(id);
				if (this.rulesBeforeSave !== void 0 && ruleFingerprint(stored) === this.rulesBeforeSave) return;
				this.ruleDrafts.clear();
			}
			/** The stored visible-model allowlist (`visibleModels`); empty = show all. */
			storedVisibleModels() {
				const raw = this.scope.getSnapshot().value?.visibleModels;
				if (!Array.isArray(raw)) return [];
				return raw.filter((m) => typeof m === "string" && m !== "");
			}
			/** Effective visible-model allowlist: staged draft or stored value. */
			effectiveVisibleModels() {
				return this.visibleModelsDraft ?? this.storedVisibleModels();
			}
			/** Whether the staged visible-model selection differs from stored. */
			visibleModelsDirty() {
				return this.visibleModelsDraft !== void 0 && !sameModels(this.visibleModelsDraft, this.storedVisibleModels());
			}
			/** Whether any visible-model staging exists. */
			visibleModelsStaged() {
				return this.visibleModelsDraft !== void 0;
			}
			/** Reset the visible-model staged edit. */
			clearVisibleModelsStaging() {
				this.visibleModelsDraft = void 0;
			}
			/** Drop visible-model staging the stored section already reflects. */
			reconcileVisibleModelsStaging() {
				if (this.visibleModelsDraft !== void 0 && sameModels(this.visibleModelsDraft, this.storedVisibleModels())) this.visibleModelsDraft = void 0;
			}
			/** The visible-model writes a save performs (empty when nothing staged). */
			visibleModelsPlan() {
				if (!this.visibleModelsDirty()) return [];
				return [() => this.writeVisibleModels()];
			}
			/** Persist the staged visible-model allowlist into the settings section. */
			async writeVisibleModels() {
				const list = this.visibleModelsDraft ?? [];
				await this.scope.set("visibleModels", list);
				return sameModels(this.storedVisibleModels(), list);
			}
			/** Stage the visible-model allowlist (multi-select). */
			editVisibleModels(models) {
				this.visibleModelsDraft = [...models];
				this.failed = false;
				this.publish();
			}
			/** Stage "show all models" (clears the allowlist). */
			clearVisibleModels() {
				this.visibleModelsDraft = [];
				this.failed = false;
				this.publish();
			}
			/** The routing-rule writes a save performs (empty when nothing staged). */
			rulesPlan() {
				if (!this.rulesDirty()) return [];
				return [() => this.writeRules()];
			}
			/** Persist the staged routing rules into the settings section. */
			async writeRules() {
				const list = [...this.storedRules().filter((rule) => {
					const snapshot = this.removedRuleIds.get(rule.id);
					return snapshot === void 0 || !sameModels(snapshot.models, rule.models) || snapshot.account !== rule.account;
				}).map((rule) => {
					const draft = this.ruleDrafts.get(rule.id);
					return {
						models: draft !== void 0 && draft.models.length > 0 ? draft.models : rule.models,
						account: draft?.account !== void 0 && draft.account !== "" ? draft.account : rule.account
					};
				}), ...this.addedRules.map((rule) => ({
					models: rule.models,
					account: rule.account
				}))].filter((rule) => rule.models.length > 0);
				const seen = /* @__PURE__ */ new Set();
				const deduped = list.filter((rule) => {
					const key = `${rule.account}\u0001${[...rule.models].sort().join("")}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				await this.scope.set("modelAccountRules", deduped);
				const after = this.storedRules();
				return after.length === deduped.length && deduped.every((item, index) => after[index] !== void 0 && sameModels(after[index].models, item.models) && after[index].account === item.account);
			}
			publish() {
				if (this.disposed) return;
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/legacy-credentials.ts
		/** Convert a legacy credentials ApiProxy into the current settings-page face. */
		function adaptLegacyCredentials(legacy) {
			if (legacy === void 0) return void 0;
			return { credentials: {
				describe: async (refs) => {
					const response = await legacy.describe({ refs });
					return response.result.ok ? {
						ok: true,
						value: response.result.value.credentials
					} : {
						ok: false,
						error: response.result.error
					};
				},
				set: async (ref, value) => {
					const response = await legacy.set({
						ref,
						value
					});
					return response.result.ok ? {
						ok: true,
						value: void 0
					} : {
						ok: false,
						error: response.result.error
					};
				},
				unset: async (ref) => {
					const response = await legacy.unset({ ref });
					return response.result.ok ? {
						ok: true,
						value: void 0
					} : {
						ok: false,
						error: response.result.error
					};
				}
			} };
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
			*/
			async refresh() {
				if (this.disposed || this.inFlight) return;
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
					if (response.ok) this.current = {
						status: "ready",
						report: response.value,
						error: void 0,
						fetchedAt: Date.now()
					};
					else this.current = {
						...this.current,
						status: "error",
						error: response.error.message
					};
				} catch (error) {
					if (this.disposed || generation !== this.generation) return;
					this.current = {
						...this.current,
						status: "error",
						error: error instanceof Error ? error.message : String(error)
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
		/** Format a dollar amount compactly (2 decimals). */
		function formatMoney(value) {
			return `$${value.toFixed(2)}`;
		}
		/** Format a dollar amount precisely (4 decimals) for small totals. */
		function formatMoneyExact(value) {
			return `$${value.toFixed(4)}`;
		}
		/** Format a large token count compactly (1.9M style). */
		function formatTokensCompact(value) {
			if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
			return String(value);
		}
		/**
		* Format a success-rate percentage (already in percent units, e.g. 99.96):
		* at most two decimals, trailing zeros trimmed — `100` stays `100`, not
		* `100.00`, and the raw upstream float `99.965552876334` becomes `99.97`.
		* The `%` suffix is appended by the caller (the card and the dashboard line
		* both compose it).
		*/
		function formatSuccessRate(value) {
			return String(Number(value.toFixed(2)));
		}
		/** One window's fill ratio in [0, 1]; 0 when uncapped. */
		function windowRatio(used, cap) {
			if (cap <= 0) return 0;
			return Math.max(0, Math.min(1, used / cap));
		}
		/** Format a millis timestamp as a local short date-time; empty when unset. */
		function formatResetAt(ms) {
			if (ms <= 0) return "";
			return new Date(ms).toLocaleString();
		}
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
		* budget. Public API mirrors {@link CommandCodeUsageController}: `state()`,
		* `subscribe`, and `ensure()`; `reload()` additionally drops the cache and
		* restarts the budget when the Host namespace rebinds.
		*
		* Not a one-shot: the last fetch is cached until `reload()`, a transient
		* failure is retried three times at 1/2/4 s (the delays are bounded, not a
		* poll), and a MANUAL `ensure()` still fetches after that budget is spent. A
		* PERMANENT failure — the Host serving no such endpoint — is terminal for the
		* binding and is only cleared by `reload()`.
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
			* unless a bounded retry already owns the next attempt.
			*
			* The only callers are the client entry: `reload()` when the Remote namespace
			* lands or rebinds, and a manual refresh. Nothing in the composer calls it, so
			* a mounted readout does not trigger a fetch of its own — it renders whatever
			* the table's state currently is.
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
						error: error instanceof Error ? error.message : String(error)
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
		//#region src/client/login.ts
		/** How often a live attempt is polled. */
		const POLL_INTERVAL_MS = 1e3;
		/**
		* The login panel's fetch/poll lifecycle. One poll loop at a time; a fresh
		* `begin()` supersedes any previous loop via a generation token.
		*/
		var CommandCodeLoginController = class {
			remote;
			listeners = /* @__PURE__ */ new Set();
			pollMs;
			/** Monotonic token; only the latest loop may publish polling results. */
			generation = 0;
			disposed = false;
			phase = "idle";
			authUrl;
			userName;
			keyName;
			reason;
			message;
			constructor(remote, pollMs = POLL_INTERVAL_MS) {
				this.remote = remote;
				this.pollMs = pollMs;
			}
			/** Subscribe to state projections. @returns the disposer. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			/** Build the current panel state face. */
			state() {
				return {
					phase: this.phase,
					authUrl: this.authUrl,
					userName: this.userName,
					keyName: this.keyName,
					reason: this.reason,
					message: this.message
				};
			}
			/** Start (or rejoin) a login attempt and begin polling its status. */
			async begin() {
				if (this.disposed || this.phase === "starting" || this.phase === "waiting") return;
				const generation = ++this.generation;
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
					result = await remote.loginBegin();
				} catch (error) {
					result = {
						ok: false,
						error: { message: error instanceof Error ? error.message : String(error) }
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
		* The per-reason copy for a failed login attempt. Shared by the settings
		* page's login panel and the Models-page card's login row — the same reasons
		* can surface from either surface.
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
		* page's `LoginPanel` and the Models-page card's login row so both surfaces
		* can never drift apart. Pure: no timers, no state — the components render it.
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
			const result = {
				mode: "strict",
				typeSymbol,
				schema,
				create: () => schema
			};
			return {
				id: `${REMOTE_PACKAGE}#${endpoint}`,
				service: REMOTE_SERVICE,
				namespace: REMOTE_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: [],
				result
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
		//#region src/client/login-row.tsx
		/** The sign-in alternative to pasting a key (settings page + Models card). */
		function LoginRow({ state, disabled, t, onBegin, onCancel }) {
			const busy = state.phase === "starting" || state.phase === "waiting";
			const hint = loginHint(state, t);
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
								disabled,
								onClick: onBegin,
								children: t("loginButton")
							})
						})]
					}),
					state.authUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							className: "cc-loginLink",
							href: state.authUrl,
							target: "_blank",
							rel: "noreferrer",
							children: t("loginOpenLink")
						})
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: hint.className,
						title: hint.title,
						children: hint.text
					})
				]
			});
		}
		//#endregion
		//#region src/client/model-select.ts
		/**
		* Model-select helpers for the settings page's model editors (browser half).
		*
		* The routing-rule editor and the visible-models filter both pick catalog
		* models through the same checkbox multi-select dropdown (`ModelMultiSelect`
		* in section.tsx). The dropdown's data shaping — search filtering, stale-id
		* detection, tier grouping — lives here, React-free, so node tests can drive
		* it directly.
		*
		* Dependency-free by design: the client bundle may only import platform/seed
		* modules, so the plan snapshot below is a deliberately small vendored copy
		* (tier key → heading label) rather than an import of src/capabilities.ts.
		* When upstream adds a plan tier, extend BOTH tables.
		*
		* @module dsh-commandcode-provider/model-select
		*/
		/**
		* Minimum plan tier → dropdown section heading. Mirrors the Host-side
		* `KNOWN_PLANS` values + `PLAN_LABELS` in src/capabilities.ts (kept as a
		* vendored copy because the client bundle cannot import host modules).
		* Covers every tier key `KNOWN_PLANS` uses today; an unknown tier key falls
		* back to the raw key rather than vanishing the row.
		*/
		const TIER_HEADINGS = {
			go: "Go",
			goat: "GOAT",
			pro: "Pro",
			provider: "Provider",
			max: "Max"
		};
		/**
		* The dropdown section heading for a catalog model id, or undefined for
		* models outside the known plan tiers (unmapped models and stale ids render
		* unheaded). `knownPlans` is the Host-side `KNOWN_PLANS` table, threaded in
		* by the caller so this module stays dependency-free.
		*/
		function tierHeadingFor(modelId, knownPlans) {
			const tier = knownPlans[modelId];
			if (tier === void 0) return void 0;
			return TIER_HEADINGS[tier] ?? tier;
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
		* Build the dropdown options: the catalog (already in picker order) plus
		* any selected ids the catalog no longer carries, flagged stale so the UI
		* can mark them — a saved selection never silently loses an entry, and the
		* user can see which ones went stale upstream.
		*
		* When `query` is non-blank, catalog rows are filtered by
		* {@link matchesModelQuery}; stale rows are kept only while they match too,
		* so a search for a live model does not surface unrelated stale ids.
		*/
		function buildModelSelectOptions(catalog, selected, query = "") {
			const catalogIds = new Set(catalog.map((model) => model.id));
			const options = catalog.filter((model) => matchesModelQuery(model, query)).map((model) => ({
				value: model.id,
				label: model.name,
				stale: false
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
		* Group dropdown options under plan-tier headings (`tierOf` maps a model id
		* to its tier heading, or undefined for unmapped models — see
		* {@link tierHeadingFor}). Live rows keep their relative order; stale ids
		* and unmapped live rows share one trailing unheaded group. Groups merge
		* repeats, so a catalog interleaving two tiers still renders one section
		* per tier.
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
		* Whether the catalog is trustworthy enough to call an unlisted selection
		* "retired". FALSE while the first fetch is still in flight and after a
		* failure, because the catalog is empty then and every selected id would look
		* stale — which turns the one-click stale cleanup into a button that silently
		* empties the allowlist. A successfully loaded but empty catalog is treated as
		* untrustworthy too: an empty list is far more likely a Host problem than every
		* model being retired at once, and the explicit "show all" entry covers the
		* user who really wants to clear the list.
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
		var version = "0.11.9";
		var repository = {
			"type": "git",
			"url": "git+https://github.com/Mars-Sea/dsh-commandcode-provider.git"
		};
		//#endregion
		//#region src/client/version.ts
		/**
		* The plugin's own version, read from package.json at build time.
		*
		* The client bundle inlines the JSON import (rolldown resolves it during the
		* tsdown build; node tests read it through tsx), so the rendered value always
		* matches the published package version with no second constant to keep in
		* sync. Rendered as a muted footer line on the settings page so a user can
		* report the exact build they run.
		*
		* @module dsh-commandcode-provider/client/version
		*/
		/** The published package version (e.g. `'0.6.0'`). */
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
		* Compare two version strings (`major.minor.patch[-pre]`). Returns a negative
		* number when `a` sorts before `b`, positive when after, zero when equal.
		*
		* Tolerant by design: a leading `v` is stripped, unparsable numeric parts
		* count as `0`, and semver prerelease rules apply (release > prerelease;
		* numeric identifiers compare numerically, everything else lexically, a
		* shorter identifier list sorts first). Enough for release tags; not a full
		* semver validator.
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
		//#region src/client/section.tsx
		/**
		* React component for the "Command Code" settings page (browser half).
		*
		* Renders as a `settings.section` entry — a page at the same settings-nav
		* level as General / Models / Plugins. The shell supplies the nav row and
		* renders this body inside the content column. All copy comes from the
		* `settings.commandcode` locale namespace; all state comes from the
		* `CommandCodeSettingsController` injected by the slot registration.
		*
		* The layout mirrors the harness's settings pages: a max-width content
		* column, labelled fields with hints, a reset affordance, and a
		* save/discard footer. Rarely touched connection facts (API base, working
		* directory, timeouts, plan filter) fold into a collapsed Advanced card
		* (`AdvancedSection`) so the page leads with the key and the usage facts.
		* Styles are injected once by the client entry
		* (see src/client/index.ts) and class-prefixed `cc-` to stay local.
		*/
		const ADVANCED_FIELDS = [
			"apiBase",
			"workingDir",
			"requestTimeoutMs",
			"streamIdleTimeoutMs",
			"transportMaxRetries",
			"filterModelsByPlan",
			"webSearch",
			"showSidebarQuota"
		];
		/** One labelled field row in the page body. */
		function Field({ id, label, hint, state, disabled, numeric, placeholder, onEdit, onReset, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "cc-label",
							htmlFor: id,
							children: label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-badges",
							children: [state.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badge",
								children: t("overridden")
							}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-reset",
								disabled,
								onClick: onReset,
								"aria-label": `${label} — ${t("reset")}`,
								children: t("reset")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						className: state.invalid ? "cc-input cc-inputInvalid" : "cc-input",
						type: "text",
						inputMode: numeric ? "numeric" : void 0,
						value: state.text,
						placeholder,
						disabled,
						onChange: (event) => onEdit(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: state.invalid ? "cc-invalid" : "cc-hint",
						children: state.invalid ? invalidCopy(state.invalidReason, t) : hint
					})
				]
			});
		}
		/** The per-field error copy for a staged draft's failure reason. */
		function invalidCopy(reason, t) {
			if (reason === "tooSmall") return t("numberTooSmall");
			if (reason === "tooLarge") return t("numberTooLarge");
			return t("invalidNumber");
		}
		/**
		* The collapsed "Advanced" card: API base, working dir, both timeouts, the
		* plan filter, the web-search backend and the sidebar quota card live here so
		* the page leads with the facts a user actually touches. Starts collapsed on
		* every visit; expands on demand. While collapsed, a badge names the
		* customized count so a nonzero override stays visible (a number field's error
		* blocks save and must be reachable).
		*/
		function AdvancedSection({ state, disabled, t, onEdit, onReset }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const overridden = ADVANCED_FIELDS.filter((field) => state[field].overridden).length;
			const invalid = ADVANCED_FIELDS.some((field) => state[field].invalid);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "cc-advancedHead",
						"aria-expanded": expanded,
						"aria-controls": "cc-advanced-body",
						onClick: () => setExpanded((value) => !value),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-advancedTitle",
								children: t("advancedSettings")
							}),
							overridden > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badge",
								children: overridden === 1 ? t("advancedOverriddenOne") : t("advancedOverriddenMany", { count: overridden })
							}) : null,
							!expanded && invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badge cc-badgeWarn",
								children: t("advancedInvalid")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-advancedSpacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: expanded ? "cc-chevron cc-chevronUp" : "cc-chevron",
								"aria-hidden": "true"
							})
						]
					}),
					expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						id: "cc-advanced-body",
						className: "cc-advancedBody",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-hint",
								children: t("advancedSettingsHint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								id: "cc-api-base",
								label: t("apiBase"),
								hint: t("apiBaseHint"),
								state: state.apiBase,
								disabled,
								onEdit: (text) => onEdit("apiBase", text),
								onReset: () => onReset("apiBase"),
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								id: "cc-working-dir",
								label: t("workingDir"),
								hint: t("workingDirHint"),
								state: state.workingDir,
								disabled,
								placeholder: state.defaultWorkingDir,
								onEdit: (text) => onEdit("workingDir", text),
								onReset: () => onReset("workingDir"),
								t
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								id: "cc-request-timeout",
								label: t("requestTimeoutMs"),
								hint: t("requestTimeoutMsHint"),
								state: state.requestTimeoutMs,
								disabled,
								numeric: true,
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
								onEdit: (text) => onEdit("transportMaxRetries", text),
								onReset: () => onReset("transportMaxRetries"),
								t
							}),
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
					}) : null,
					expanded && invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-invalid",
						role: "status",
						children: t("advancedInvalid")
					}) : null
				]
			});
		}
		/**
		* One boolean field row rendered as a toggle. The staged text is `'true'` /
		* `'false'` / `''` (unset → `defaultChecked`); toggling stages the string the
		* boolean field spec parses back into a real boolean on save.
		*/
		function ToggleField({ id, label, hint, state, disabled, defaultChecked, onEdit, onReset, t }) {
			const checked = state.text === "" ? defaultChecked : state.text === "true";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-fieldHead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-label",
						"aria-hidden": "true",
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "cc-badges",
						children: [state.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-badge",
							children: t("overridden")
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "cc-reset",
							disabled,
							onClick: onReset,
							"aria-label": `${label} — ${t("reset")}`,
							children: t("reset")
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: "cc-toggleRow",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						className: "cc-toggle",
						type: "checkbox",
						role: "switch",
						checked,
						disabled,
						onChange: (event) => onEdit(event.target.checked ? "true" : "false")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cc-hint",
						children: hint
					})]
				})]
			});
		}
		/**
		* The API-key control: write-only, reports configured state, never echoes the
		* key. The input is masked by default with a Show/Hide toggle so a pasted key
		* can be spot-checked without leaving the field, and a stored key can be
		* staged for removal (the next save unsets it) when it is bad or unwanted.
		*/
		function SecretKeyField({ label, hint, state, disabled, configured, configuredLabel, unconfiguredLabel, clearStaged, showLabel, hideLabel, clearLabel, clearStagedLabel, undoClearLabel, onEdit, onToggleClear }) {
			const [visible, setVisible] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "cc-label",
							htmlFor: "cc-api-key",
							children: label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-badges",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: configured ? "cc-badge" : "cc-badgeMuted",
									children: configured ? configuredLabel : unconfiguredLabel
								}),
								clearStaged ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeWarn",
									children: clearStagedLabel
								}) : null,
								configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onToggleClear,
									children: clearStaged ? undoClearLabel : clearLabel
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: () => setVisible((value) => !value),
									children: visible ? hideLabel : showLabel
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cc-api-key",
						className: "cc-input",
						type: visible ? "text" : "password",
						autoComplete: "off",
						spellCheck: false,
						value: state.text,
						disabled,
						onChange: (event) => onEdit(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: hint
					})
				]
			});
		}
		/** One stat tile in the account card's summary grid. */
		function UsageStat({ label, value, sub }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-usageStat",
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
			const reset = formatResetAt(resetAt);
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
							style: { width: `${ratio * 100}%` }
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
		/** One account's rotation state as a short badge next to its label. */
		function AccountMark({ entry, t }) {
			if (entry.active) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-usagePlan",
				children: t("usageActive")
			});
			if (entry.mark === "invalid-credential") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-usagePlanStatus",
				children: t("usageInvalidKey")
			});
			if (entry.cooldownUntil > 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cc-usagePlanStatus",
				children: [
					t("usageCooldown"),
					" ",
					formatResetAt(entry.cooldownUntil)
				]
			});
			if (entry.mark === "rate-limit") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cc-usagePlanStatus",
				children: t("usageCooldown")
			});
			return null;
		}
		/**
		* One pool account's facts (identity, totals, credits, window limits)
		* rendered inside the account-usage card.
		*/
		function AccountReport({ entry, fetchedAt, t, onRemove }) {
			const report = entry.report;
			const account = report.account;
			const accountName = account === void 0 ? "" : account.userName || account.name;
			const credits = report.credits;
			const plan = report.plan;
			const planName = plan?.name ?? "";
			const planStatus = plan !== void 0 && plan.status !== "" && plan.status !== "active" ? plan.status : "";
			const showPeriod = plan !== void 0 && plan.currentPeriodEnd > 0;
			const showPartial = report.failures.length > 0 && report.blocked === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-accountReport",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								className: "cc-usageTitle",
								children: entry.label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountMark, {
								entry,
								t
							}),
							accountName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usageAccount",
								children: accountName
							}) : null,
							planName !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usagePlan",
								children: planName
							}) : null,
							planStatus !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-usagePlanStatus",
								children: planStatus
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-usageMetaSpacer" }),
							onRemove !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-usageRefresh",
								onClick: onRemove,
								children: t("accountRemove")
							}) : null
						]
					}),
					!entry.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usageHint",
						children: t("usageUnconfigured")
					}) : null,
					report.blocked !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageBlocked",
						role: "alert",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-usageBlockedTitle",
								children: blockedTitle(report.blocked, t)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-usageBlockedHint",
								children: blockedHint(report.blocked, t)
							}),
							report.failures.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-usageBlockedDetail",
								title: report.failures.join("; "),
								children: report.failures.join(" · ")
							}) : null
						]
					}) : null,
					report.usage !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageStats",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageRequests"),
								value: String(report.usage.completedCount),
								sub: `${t("usageFailed")} ${report.usage.failedCount}`
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
					credits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageStats",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageMonthly"),
								value: credits.monthlyReported === false ? "—" : formatMoney(credits.monthlyCredits)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usagePurchased"),
								value: credits.purchasedReported === false ? "—" : formatMoney(credits.purchasedCredits)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageStat, {
								label: t("usageFree"),
								value: credits.freeReported === false ? "—" : formatMoney(credits.freeCredits)
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
					showPeriod || showPartial || fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageMeta",
						children: [
							showPeriod ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "cc-usageUpdated",
								children: [
									t("usagePeriodEnd"),
									" ",
									new Date(plan.currentPeriodEnd).toLocaleDateString()
								]
							}) : null,
							showPartial ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-usagePartial",
								title: report.failures.join("; "),
								children: t("usagePartial")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-usageMetaSpacer" }),
							fetchedAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "cc-usageUpdated",
								children: [
									t("usageUpdated"),
									" ",
									new Date(fetchedAt).toLocaleTimeString()
								]
							}) : null
						]
					}) : null
				]
			});
		}
		/** The headline copy for a report whose every endpoint failed the same way. */
		function blockedTitle(reason, t) {
			if (reason === "invalid-key") return t("usageKeyInvalid");
			if (reason === "service-unavailable") return t("usageServiceUnavailable");
			return t("usageNetworkError");
		}
		/** The actionable hint under a blocked report's headline. */
		function blockedHint(reason, t) {
			if (reason === "invalid-key") return t("usageKeyInvalidHint");
			if (reason === "service-unavailable") return t("usageServiceUnavailableHint");
			return t("usageNetworkHint");
		}
		/** The status dot on an account tab: cooling/invalid warn, everything else ok. */
		function AccountTabDot({ entry }) {
			const cls = entry.mark === "invalid-credential" ? "cc-tabDot cc-tabDotError" : entry.mark !== "" || entry.cooldownUntil > 0 ? "cc-tabDot cc-tabDotWarn" : "cc-tabDot cc-tabDotOk";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cls,
				"aria-hidden": "true"
			});
		}
		/**
		* The account-usage card: the `/commandcode` dashboard's facts rendered as
		* a native settings card. With several accounts the card is a carousel — a
		* tab strip (label + status dot) switches between accounts so the page stays
		* short; each account's report carries its own remove affordance (the
		* default account is not removable). Accounts staged for removal in the
		* management card are hidden here immediately. Data arrives through the
		* `commandcode/report` Remote; the API keys never leave the Host.
		*/
		function UsageCard({ t, usage, removingIds, removableIds, canManage, onRefresh, onRemoveAccount }) {
			const { loading, shouldRefresh, noKey } = usageCardState(usage);
			(0, react.useEffect)(() => {
				if (shouldRefresh) onRefresh();
			}, [shouldRefresh, onRefresh]);
			const report = usage.report;
			const [locallyRemoved, setLocallyRemoved] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				setLocallyRemoved([]);
			}, [usage.fetchedAt]);
			const hidden = /* @__PURE__ */ new Set([...removingIds, ...locallyRemoved]);
			const seenIds = /* @__PURE__ */ new Set();
			const entries = (report?.accounts ?? []).filter((entry) => {
				if (hidden.has(entry.id)) return false;
				if (seenIds.has(entry.id)) return false;
				seenIds.add(entry.id);
				return true;
			});
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const selected = entries.find((entry) => entry.id === selectedId) ?? entries.find((entry) => entry.active) ?? entries[0];
			const removeSelected = canManage && selected !== void 0 && removableIds.includes(selected.id) ? () => {
				const id = selected.id;
				setLocallyRemoved((prev) => [...prev, id]);
				onRemoveAccount(id);
			} : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-usageCard",
				"aria-label": t("usageTitle"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-usageHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "cc-usageTitle",
								children: t("usageTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "cc-usageMetaSpacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-usageRefresh",
								disabled: loading,
								onClick: onRefresh,
								children: loading ? t("usageRefreshing") : t("usageRefresh")
							})
						]
					}),
					noKey ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usageHint",
						children: t("usageNoKey")
					}) : null,
					report === void 0 && loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usageHint",
						children: t("usageLoading")
					}) : null,
					usage.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-usageError",
						role: "status",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("usageError"), usage.error !== void 0 && usage.error !== "" ? ` — ${usage.error}` : ""] })
					}) : null,
					entries.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "cc-tabs",
						"aria-label": t("accountsTitle"),
						children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							"aria-pressed": selected?.id === entry.id,
							className: selected?.id === entry.id ? "cc-tab cc-tabActive" : "cc-tab",
							onClick: () => setSelectedId(entry.id),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountTabDot, { entry }), entry.label]
						}, entry.id))
					}) : null,
					selected !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountReport, {
						entry: selected,
						fetchedAt: usage.fetchedAt,
						t,
						onRemove: removeSelected
					}, selected.id) : null
				]
			});
		}
		/**
		* One extra account row: label, key, configured badge. Saved accounts are
		* removed from the usage card above; a NOT-YET-SAVED addition never appears
		* there (the usage report is Host-side), so it keeps its own remove button —
		* otherwise the only way to undo a mistaken Add would be discarding every
		* other staged edit.
		*/
		function AccountRow({ account, disabled, t, onLabel, onKey, onToggleClear, onRemove }) {
			const locked = !account.writable;
			const [keyVisible, setKeyVisible] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "cc-label",
							htmlFor: `cc-account-label-${account.id}`,
							children: t("accountLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-badges",
							children: [
								account.added ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge",
									children: t("unsaved")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: account.configured ? "cc-badge" : "cc-badgeMuted",
									children: account.configured ? t("apiKeySet") : t("apiKeyUnset")
								}),
								account.clearStaged ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badge cc-badgeWarn",
									children: t("usageKeyClearStaged")
								}) : null,
								account.configured && !account.clearStaged ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onToggleClear,
									children: t("usageKeyClear")
								}) : null,
								account.clearStaged ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onToggleClear,
									children: t("usageUndoKeyClear")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: () => setKeyVisible((value) => !value),
									children: keyVisible ? t("hide") : t("show")
								}),
								account.added ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onRemove,
									children: t("accountRemove")
								}) : null
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: `cc-account-label-${account.id}`,
						className: "cc-input",
						type: "text",
						value: account.label,
						disabled,
						onChange: (event) => onLabel(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: `cc-account-key-${account.id}`,
						className: "cc-input",
						type: keyVisible ? "text" : "password",
						autoComplete: "off",
						spellCheck: false,
						placeholder: t("accountKey"),
						value: account.keyText,
						disabled: disabled || locked,
						onChange: (event) => onKey(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: locked ? t("apiKeyLocked") : t("accountKeyHint")
					})
				]
			});
		}
		/** The multi-account card: the active-account selector + extra accounts in rotation order + add button. */
		function AccountsCard({ t, state, disabled, onAdd, onRemove, onLabel, onKey, onToggleClear, onActive, onActiveReset }) {
			const active = state.activeAccount;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-card",
				"aria-label": t("accountsTitle"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-field",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cc-fieldHead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "cc-label",
								children: t("accountsTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badges",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onAdd,
									children: t("accountAdd")
								})
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-hint",
							children: t("accountsHint")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-field",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "cc-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "cc-label",
									htmlFor: "cc-active-account",
									children: t("activeAccount")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "cc-badges",
									children: [active.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "cc-badge",
										children: t("overridden")
									}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "cc-reset",
										disabled,
										onClick: onActiveReset,
										children: t("reset")
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								id: "cc-active-account",
								className: "cc-input",
								value: active.text,
								disabled,
								onChange: (event) => onActive(event.target.value),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("activeAccountAuto")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "default",
										children: t("accountDefault")
									}),
									state.accounts.filter((account) => !account.added).map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: account.ref,
										children: account.label
									}, account.id))
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-hint",
								children: t("activeAccountHint")
							})
						]
					}),
					state.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
						account,
						disabled,
						t,
						onLabel: (text) => onLabel(account.id, text),
						onKey: (text) => onKey(account.id, text),
						onToggleClear: () => onToggleClear(account.id),
						onRemove: () => onRemove(account.id)
					}, account.id))
				]
			});
		}
		/** One model → account routing rule row. */
		function RuleRow({ rule, accounts, catalog, disabled, t, onModels, onAccount, onRemove }) {
			const targets = [{
				value: "default",
				label: t("accountDefault")
			}, ...accounts.filter((account) => !account.added).map((account) => ({
				value: account.ref,
				label: account.label
			}))];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "cc-label",
							htmlFor: `cc-rule-model-${rule.id}`,
							children: t("ruleModel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "cc-badges",
							children: [rule.added ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "cc-badge",
								children: t("unsaved")
							}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "cc-reset",
								disabled,
								onClick: onRemove,
								children: t("ruleRemove")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelMultiSelect, {
						id: `cc-rule-model-${rule.id}`,
						selected: rule.models,
						catalog,
						disabled,
						t,
						onSelect: onModels
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						id: `cc-rule-account-${rule.id}`,
						className: "cc-input",
						value: rule.account,
						disabled,
						onChange: (event) => onAccount(event.target.value),
						"aria-label": t("ruleAccount"),
						children: targets.map((target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: target.value,
							children: target.label
						}, target.value))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: t("ruleHint")
					})
				]
			});
		}
		/**
		* A checkbox multi-select dropdown for picking catalog models (the
		* routing-rule rows and the visible-models filter share it). The trigger
		* shows the selection count; the Menu lists every catalog model with a
		* checkbox, toggled by clicking the row. A search box under the trigger
		* (inside the Menu anchor, so focusing it never trips the outside-click
		* close) filters the list by id/display-name substring, and items group
		* under plan-tier headings in picker order. Selected ids the catalog no
		* longer carries still render — flagged stale — so a saved selection never
		* silently loses an entry, and the VisibleModelsCard offers a one-click
		* cleanup.
		*/
		function ModelMultiSelect({ id, selected, catalog, disabled, t, onSelect }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				if (open) setQuery("");
			}, [open]);
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
						}) : null
					]
				})
			}))]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => setOpen(false),
				onSelect: (modelId) => {
					onSelect(toggleModelSelection(selected, modelId));
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
						className: "cc-input cc-ruleTrigger",
						disabled: disabled || catalog.length === 0,
						onClick: () => setOpen((value) => !value),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-ruleTriggerText",
							children: selected.length === 0 ? t("ruleModelPick") : t("ruleModelCount", { count: selected.length })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "cc-ruleCaret",
							"aria-hidden": "true"
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
		/** The model → account routing card: rules in list order (first match wins). */
		function RulesCard({ t, state, disabled, onAdd, onRemove, onModels, onAccount }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "cc-card",
				"aria-label": t("rulesTitle"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-field",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "cc-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "cc-label",
									children: t("rulesTitle")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "cc-badges",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "cc-reset",
										disabled,
										onClick: onAdd,
										children: t("ruleAdd")
									})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-hint",
								children: t("rulesHint")
							}),
							state.catalogFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-invalid",
								children: t("rulesCatalogFailed")
							}) : null
						]
					}),
					state.rules.map((rule) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuleRow, {
						rule,
						accounts: state.accounts,
						catalog: state.catalogModels,
						disabled,
						t,
						onModels: (ids) => onModels(rule.id, ids),
						onAccount: (text) => onAccount(rule.id, text),
						onRemove: () => onRemove(rule.id)
					}, rule.id)),
					state.rules.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-hint",
						children: t("rulesEmpty")
					}) : null
				]
			});
		}
		/** The visible-model filter card: an allowlist over the catalog. Empty = show all. */
		function VisibleModelsCard({ t, state, disabled, onSelect, onClear }) {
			const count = state.visibleModels.length;
			const pickT = (key, params) => {
				if (key === "ruleModelPick") return t("visibleModelsPick");
				if (key === "ruleModelCount") return t("visibleModelsCount", params);
				return t(key, params);
			};
			const readiness = {
				catalogIds: state.catalogModels.map((model) => model.id),
				catalogFailed: state.catalogFailed
			};
			const staleIds = staleModelIds(state.visibleModels, readiness);
			const catalogReady = catalogIsReady(readiness);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "cc-card",
				"aria-label": t("visibleModelsTitle"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "cc-field",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "cc-fieldHead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "cc-label",
								children: t("visibleModelsTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "cc-badges",
								children: [catalogReady && staleIds.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: () => onSelect(state.visibleModels.filter((id) => !staleIds.includes(id))),
									children: t("visibleModelsCleanStale", { count: staleIds.length })
								}) : null, count > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled,
									onClick: onClear,
									children: t("visibleModelsShowAll")
								}) : null]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-hint",
							children: t("visibleModelsHint")
						}),
						state.catalogFailed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-invalid",
							children: t("rulesCatalogFailed")
						}) : null,
						staleIds.length > 0 && catalogReady ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "cc-hint",
							children: t("visibleModelsStaleHint", { count: staleIds.length })
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelMultiSelect, {
							id: "cc-visible-models",
							selected: state.visibleModels,
							catalog: state.catalogModels,
							disabled,
							t: pickT,
							onSelect
						})
					]
				})
			});
		}
		/**
		* Show the "Saved ✓" affordance for a short window after each accepted save.
		* The controller only counts saves (`savedCount`); the flash timing lives
		* here so the state machine stays timer-free.
		*/
		function useSavedFlash(tick) {
			const [visible, setVisible] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (tick === 0) return;
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
		/** The settings page body: connection facts for the Command Code provider. */
		function CommandCodeSettingsPage(props) {
			const { t } = props;
			const state = props.useCommandCodeSettings((snapshot) => snapshot);
			const usage = props.useCommandCodeUsage((snapshot) => snapshot);
			const login = props.useCommandCodeLogin((snapshot) => snapshot);
			const disabled = !state.writable;
			const keyLocked = !state.apiKeyWritable;
			const savedVisible = useSavedFlash(state.savedCount);
			const updateVersion = usePluginUpdate();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "cc-section",
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
					!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "cc-readOnly",
						role: "status",
						children: t("readOnly")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageCard, {
						t,
						usage,
						removingIds: state.accountsRemoving,
						removableIds: state.accounts.map((account) => account.id),
						canManage: state.writable,
						onRefresh: props.refreshUsage,
						onRemoveAccount: props.removeAccount
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountsCard, {
						t,
						state,
						disabled,
						onAdd: props.addAccount,
						onRemove: props.removeAccount,
						onLabel: props.editAccountLabel,
						onKey: props.editAccountKey,
						onToggleClear: (id) => props.toggleKeyClear(id),
						onActive: (text) => props.edit("activeAccount", text),
						onActiveReset: () => props.resetField("activeAccount")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RulesCard, {
						t,
						state,
						disabled,
						onAdd: props.addRule,
						onRemove: props.removeRule,
						onModels: props.editRuleModels,
						onAccount: props.editRuleAccount
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VisibleModelsCard, {
						t,
						state,
						disabled,
						onSelect: props.editVisibleModels,
						onClear: props.clearVisibleModels
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SecretKeyField, {
							label: t("apiKey"),
							hint: keyLocked ? t("apiKeyLocked") : t("apiKeyHint"),
							state: state.apiKey,
							disabled: disabled || keyLocked,
							configured: state.apiKeyConfigured,
							configuredLabel: t("apiKeySet"),
							unconfiguredLabel: t("apiKeyUnset"),
							clearStaged: state.apiKeyClearStaged,
							showLabel: t("show"),
							hideLabel: t("hide"),
							clearLabel: t("usageKeyClear"),
							clearStagedLabel: t("usageKeyClearStaged"),
							undoClearLabel: t("usageUndoKeyClear"),
							onEdit: (text) => props.edit("apiKey", text),
							onToggleClear: () => props.toggleKeyClear("default")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginRow, {
							state: login,
							disabled: disabled || keyLocked,
							t,
							onBegin: props.beginLogin,
							onCancel: props.cancelLogin
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AdvancedSection, {
						state,
						disabled,
						t,
						onEdit: props.edit,
						onReset: props.resetField
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "cc-footer",
						children: [
							state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-failed",
								role: "status",
								children: t("saveFailed")
							}) : null,
							savedVisible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "cc-saved",
								role: "status",
								children: t("saved")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: !state.dirty || state.saving,
								onClick: props.discard,
								children: t("discard")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: !state.dirty || state.invalid || state.saving,
								onClick: props.save,
								children: t(state.saving ? "saving" : "save")
							})
						]
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
					})
				]
			});
		}
		/**
		* Find the official editor card among the slot outlet's siblings, or null
		* while it is closed. The Models page renders the editor as an immediate
		* sibling of the outlet wrapper — after it in a provider row (the target of
		* the row's 编辑 toggle), before it in the first-run setup card and the
		* add-provider card, where it is always open. The editor is the only such
		* sibling whose CSS module class carries the `editor` stem
		* (`<hash>_editor`); the row header and the add card's provider select
		* never do, so the lookup needs no hash knowledge.
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
		/** Status badge for the credential state (green when configured). */
		function StatusBadge({ ok, okLabel, pendingLabel }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: ok ? "cc-badge" : "cc-badgeMuted",
				children: ok ? okLabel : pendingLabel
			});
		}
		/** Compact key field for the not-configured card. */
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
						autoComplete: "off",
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
		* the Models page (saved row, first-run setup posture, and add-provider
		* draft).
		*
		* Closed (the official 编辑 toggle off) the panel renders nothing: the row
		* head the Models page owns already names the provider and shows the
		* credential dot, so a page full of providers stays compact. Opening the
		* official editor mounts the editor shell as the outlet's sibling; the panel
		* watches for it, hides the shell (it carries only the settings.yaml hint and
		* a disabled apply for this namespace), and shows the real controls — badges,
		* API-key field, sign-in, discard/save.
		*/
		function CommandCodeProviderCard(props) {
			const { t } = props;
			const state = props.useCommandCodeSettings !== void 0 ? props.useCommandCodeSettings((snapshot) => snapshot) : void 0;
			const mode = cardMode(state);
			const login = props.useCommandCodeLogin !== void 0 ? props.useCommandCodeLogin((snapshot) => snapshot) : void 0;
			const dirty = state?.dirty ?? false;
			const saving = state?.saving ?? false;
			const invalid = state?.invalid ?? false;
			const failed = state?.failed ?? false;
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
										pendingLabel: t("apiKeyUnset")
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
								failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "cc-failed",
									role: "status",
									children: t("saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "cc-reset",
									disabled: !dirty || saving,
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
		//#region src/client/panel-copy.ts
		/** The locale namespace both panel slots bind their `t` seat to. */
		const PANEL_LOCALE_NS = "panel.commandcode";
		/** The panel's Simplified Chinese string table (the key-set source of truth). */
		const PANEL_COPY_ZH = {
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
			errorGeneric: "用量获取失败"
		};
		/** The panel's English string table (must mirror {@link PANEL_COPY_ZH}). */
		const PANEL_COPY_EN = {
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
		function money(value) {
			if (value === 0) return formatMoney(0);
			return Math.abs(value) < .01 ? formatMoneyExact(value) : formatMoney(value);
		}
		/**
		* What a figure shows when the endpoint that carries it did not report one.
		* A dash, never a zero: the panel exists to state what the account has spent,
		* so "we were not told" has to look different from "nothing".
		*/
		const UNREPORTED = "—";
		/** Local reset time; empty when the endpoint reported none. */
		function resetText(ms) {
			if (ms <= 0) return "";
			return new Date(ms).toLocaleString();
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
				value: capped ? `${money(limit.used)} / ${money(limit.cap)}` : money(limit.used),
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
		* `monthlyCredits` — that field is a remaining balance (see
		* {@link PanelMonthlyView}). Unknown plans (no `monthlyCredits` on the plan
		* record) therefore still show their balances, just without a ratio.
		*
		* The trap this guards: a MISSING balance is not a consumed one. The billing
		* endpoint is one of four the report fetches in parallel, so it fails on its
		* own while the plan still arrives — and reading the absent balance as 0 would
		* turn that partial failure into `limit - 0 = limit`, i.e. a confident "100%
		* used, quota exhausted" for an account that may have spent nothing. The
		* official CLI draws no meter unless the credits payload is present at all
		* (`hasCreditsInfo`), so "unreported" is the upstream-faithful reading here
		* too. Every derived figure stays a placeholder until the balance reported.
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
				limit: limitValue !== null ? money(limitValue) : UNREPORTED,
				used: known ? money(used) : UNREPORTED,
				remaining: remainingReported ? money(remaining) : UNREPORTED,
				purchased: credits !== void 0 && credits.purchasedReported !== false ? money(Math.max(0, credits.purchasedCredits)) : UNREPORTED,
				free: credits !== void 0 && credits.freeReported !== false ? money(Math.max(0, credits.freeCredits)) : UNREPORTED,
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
			const stats = [];
			if (usage !== void 0) {
				stats.push({
					label: "requests",
					value: String(usage.completedCount),
					sub: `${usage.failedCount} ${t("failed")}`
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
				stats
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
			if (state.status === "error" && state.report === void 0) return {
				title: "errorGeneric",
				hint: "errorGeneric",
				detail: state.error ?? ""
			};
		}
		/**
		* Every panel string, resolved once per projection through the translator.
		* One object with all keys (rather than per-field lookups in the components)
		* keeps the copy table and the render sites in lockstep: a key cannot be read
		* from `text` unless {@link PANEL_KEYS} declares it.
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
		* credential twice, and removal staging hides an account before the post-save
		* refresh lands.
		*/
		function buildPanelView(input) {
			const { usage } = input;
			const t = input.t ?? panelTextEN;
			const hidden = new Set(input.removingIds ?? []);
			const seen = /* @__PURE__ */ new Set();
			const entries = (usage.report?.accounts ?? []).filter((entry) => {
				if (hidden.has(entry.id)) return false;
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
					detail: `${money(window.used)} / ${money(window.cap)}`
				});
			}
			const totalCost = selectedEntry?.report.usage?.totalCost;
			const cost = totalCost === void 0 ? "" : money(totalCost);
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
		* How often the panel re-reads the report while a surface is mounted. The
		* quota windows move slowly and one report costs four upstream calls, so this
		* is a background freshness tick, not a live meter.
		*/
		const PANEL_AUTO_REFRESH_MS = 12e4;
		/** The default timer (the client bundle runs in a browser; node tests inject one). */
		const REAL_TIMER = {
			set: (callback, ms) => setTimeout(callback, ms),
			clear: (handle) => clearTimeout(handle)
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
		* Start the shared auto refresh. One fetch when the surface appears (the
		* sidebar row is the point of the panel — it must be current, not wait for a
		* click), then a tick every {@link PANEL_AUTO_REFRESH_MS} while a surface
		* stays mounted.
		*
		* Reference-counted: the sidebar entry and the dashboard can be mounted at
		* once, so only the first start fetches and only the last stop halts the loop.
		* Every tick goes through `usage.refresh()`, which already collapses a
		* concurrent fetch onto the in-flight one — a tick never double-fetches
		* against the settings page's own refresh.
		*
		* @param usage - the shared usage controller.
		* @param isConfigured - whether a credential exists right now (re-read per tick).
		* @param timer - timer seam for tests.
		* @returns the disposer that drops this surface's reference.
		*/
		function startPanelAutoRefresh(usage, isConfigured, timer = REAL_TIMER) {
			references += 1;
			const ticket = ++ticketSeq;
			const tick = () => {
				if (activeTicket !== ticket) return;
				if (isConfigured()) usage.refresh();
				handle = timer.set(tick, PANEL_AUTO_REFRESH_MS);
			};
			if (activeTicket === void 0) {
				activeTicket = ticket;
				handle = timer.set(tick, PANEL_AUTO_REFRESH_MS);
				if (isConfigured()) usage.refresh();
			}
			let stopped = false;
			return () => {
				if (stopped) return;
				stopped = true;
				references -= 1;
				if (references > 0) return;
				activeTicket = void 0;
				if (handle !== void 0) {
					timer.clear(handle);
					handle = void 0;
				}
			};
		}
		//#endregion
		//#region src/client/panel-view.tsx
		/**
		* React components for the Command Code plans & quota panel (browser half):
		* the sidebar footer card and the dashboard it opens in the center column.
		*
		* Both render one {@link PanelView} projected by `./panel.ts` — no fact is
		* derived here. Strings arrive already localized in `view.text`: the slots
		* declare the `panel.commandcode` locale namespace, so the renderer hands this
		* component a `t` seat that is passed into `buildPanelView` — the panel follows
		* the harness's active language (a language switch mints a new `t`, so the
		* surfaces re-render without an extra channel).
		*
		* The footer card is the panel's home: the sidebar shell renders it in the foot
		* area directly above the Settings seat, so each quota window's own spend and
		* limit — the 5-hour and the weekly one — are on screen without opening
		* anything. Clicking it selects the `main` panel this file also renders — and
		* unlike a `sidebar.panellist` row, whose button chrome and label the SHELL
		* owns, this entry owns its whole surface and therefore calls `open()` itself.
		*
		* Styles ride the stylesheet `./panel-styles.ts` returns, injected once by
		* the client entry; classes are `ccp-` prefixed to stay clear of the settings
		* page's `cc-` set.
		*
		* @module dsh-commandcode-provider/client/panel-view
		*/
		/** The panel's view, recomputed from both seats on every notification. */
		function usePanelView(props) {
			const usage = props.useCommandCodeUsage((state) => state);
			const settings = props.useCommandCodeSettings((state) => state);
			return buildPanelView({
				usage,
				apiKeyConfigured: settings.anyAccountConfigured,
				removingIds: settings.accountsRemoving,
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
		function Tile({ label, value, sub }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "ccp-tile",
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
		/** One usage tile. */
		function StatTile({ stat, label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Tile, {
				label,
				value: stat.value,
				sub: stat.sub
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
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							className: "ccp-blockTitle",
							children: text("usage")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "ccp-tiles",
							children: account.stats.map((stat) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								stat,
								label: text(stat.label)
							}, stat.label))
						})]
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
			const text = (key) => view.text[key] ?? key;
			const [selectedId, setSelectedId] = (0, react.useState)(void 0);
			const startAutoRefresh = props.startAutoRefresh;
			(0, react.useEffect)(() => startAutoRefresh(), [startAutoRefresh]);
			const accounts = view.accounts;
			const selected = accounts.find((account) => account.id === selectedId) ?? view.selected ?? accounts[0];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "ccp-main",
				role: "region",
				"aria-label": text("nav"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "ccp-mainInner",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "ccp-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "ccp-headerText",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: "ccp-title",
										children: text("nav")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "ccp-subtitle",
										children: text("subtitle")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "ccp-spacer" }),
								view.updatedAt !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
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
									disabled: view.loading,
									onClick: () => props.refresh(),
									children: view.loading ? text("refreshing") : text("refresh")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "ghost",
									size: "sm",
									className: "ccp-close",
									"aria-label": text("close"),
									title: text("closeHint"),
									onClick: () => props.close(),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										children: "×"
									})
								})
							]
						}),
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
					]
				})
			});
		}
		/**
		* The sidebar footer card, registered into `sidebar.footer.action` — the list
		* the shell renders in the sidebar's foot area directly ABOVE the Settings
		* seat, so the panel reads as a bottom-pinned sibling of Settings rather than
		* a global panel icon at the top of the column.
		*
		* The shell wraps nothing here, so this component owns the surface: the
		* button, its chrome and its accessible name. In the expanded column it draws
		* the title row, then one block per quota window (5-hour, then weekly) — the
		* window's own spend and limit (`$1.32 / $6.00`), its percentage and its bar —
		* and nothing else: the card's figures are the two windows the account runs
		* into, so the period total stays in the tooltip rather than taking a third
		* line. In the 56px rail it collapses to a 36px icon button carrying the ring,
		* matching the shell's own rail geometry. `wide` comes from the shell as an
		* owner prop — unlike the old `sidebar.panellist` row, this slot really does
		* supply it.
		*
		* Rendering is gated on the settings page's `showSidebarQuota` toggle, which
		* defaults OFF: a fresh install shows no quota surface in the sidebar and runs
		* no background poll. The gate reads the STORED document (the settings
		* controller's `sidebarQuota` fact), so an unsaved draft cannot show the card,
		* while a landed save flips it live. The entry is still REGISTERED — this is a
		* render decision, not a slot registration, so nothing churns the slot ledger.
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
		* All prompt billing buckets determine a request's band, never cumulative session input.
		*
		* A tiered model returns the matching band and does NOT then apply `peak`: the
		* page publishes those two dimensions independently, no row carries both today,
		* and the generator would report a tiered row on every sync — so the combination
		* becoming real is visible before it reaches a user. This ordering is a latent
		* choice, not a verified upstream rule.
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
		//#endregion
		//#region src/client/session-cost.ts
		/**
		* Session-cost view model for the composer readout.
		*
		* Deliberately JSX-free and React-free, mirroring `./panel.ts`: it turns the
		* session's token accounting plus the Host's price table into one presentation
		* value AND the exact text the two surfaces of the harness's token-usage UI
		* receive — the amount appended to the shipped pill, and the rows appended to
		* the shipped usage dialog. Node tests therefore drive the whole calculation,
		* and every user-visible string, without a DOM.
		*
		* The figures it prices are the session's DURABLE cumulative buckets, which is
		* what the composer's own "N tokens" pill reads too (`tokenUsage`), so the two
		* surfaces can never disagree about how much was used. Dollars are computed
		* here because Command Code publishes per-token rates and bills against
		* dollar-denominated windows; the account's own reported `totalCost` is a
		* billing PERIOD figure, not this session's.
		*
		* Three rules are load-bearing:
		*
		* 1. **Only Command Code usage is priced.** A session served by another
		*    provider must render nothing, never a Command Code estimate.
		* 2. **A missing rate is never invented.** The pricing page publishes
		*    input/output/cache-read rates for every model but a cache-WRITE rate for
		*    only some, so unpriced cache-write tokens are surfaced as such rather than
		*    charged at a guessed multiple of the input rate.
		* 3. **Unpriceable means invisible.** No usage, no model, no table, an unknown
		*    model, or all-zero buckets renders nothing at all — a confident `$0.00`
		*    would be a lie, and this module never returns one.
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
			/** The heading the tooltip leads with. */
			panelTitle: "Session cost",
			/** Marks an estimate from published rates rather than an invoice. */
			approximate: "≈",
			/** Tooltip line for the unpriced cache-write tokens. */
			unpricedCacheWrite: "cache write tokens have no published rate",
			/** Tooltip line naming the rate half in force. */
			peakRates: "peak rates",
			/** Tooltip line naming the rate half in force. */
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
		* `toFixed(4)` would print a flat `$0.0000` — which reads as broken rather than
		* as small. So a total under $0.0001 is stated as a bound instead.
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
			if (COST_TOKEN_KEYS.some((key) => totals[key] !== count(usage[key])) || !priced) return void 0;
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
		* A PREFERENCE, not a requirement: 0.1.6-alpha.2 dropped this attribute from the
		* row's root while leaving the rest of the markup identical, so a lookup that
		* insisted on it would silently stop finding the row on that engine. When it is
		* absent the search falls back to the dock OUTLET — deliberately the outlet and
		* never the outlet's parent, because from 0.1.6-alpha.2 the parent is the new
		* composer footer, which holds the `ContextMeter` as well, and that meter's
		* trigger is itself a `button[aria-haspopup="dialog"]` rendered AFTER the dock.
		* A parent-scoped "last trigger wins" would therefore append the cost to the
		* context ring instead of the token pill.
		*/
		const STATS_ROOT = "[data-composer-stats]";
		/**
		* The shipped token-usage dialog's `<dl>`. Unique WITHIN one `StatsPills`
		* render: the per-message turn-usage panel has its own dialog with different
		* markup, so a single composer's usage dialog is unambiguous. It is not unique
		* across the document once two composers are live — see {@link resolveDialog}.
		*/
		const USAGE_DIALOG = "[data-session-stats-usage]";
		/**
		* The usage dialog's trigger. Both pills announce a dialog, but the token one is
		* rendered LAST — and when no step carries timing the time pill is not a button
		* at all, so "last" still selects the token pill in both cases.
		*/
		const DIALOG_TRIGGER = "button[aria-haspopup=\"dialog\"]";
		/**
		* Stable id for the hidden node the appended cost is described by. The pill's
		* own `aria-label` is computed by the harness on every render and cannot be
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
			* registration order. {@link STATS_ROOT} narrows that to the stats row on the
			* engines that still mark it; on the engines that do not, the outlet is
			* already the narrowest correct container, because the composer footer's
			* `ContextMeter` sits BESIDE the outlet rather than inside it.
			*
			* A missing scope is "no pill", never a document-wide search: the outlet is
			* what makes this lookup per-composer, and a second composer can be live at
			* once (0.1.6-alpha.2 mounts an embedded Conversation in the sidebar).
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
			* document. While one composer was guaranteed, a document-level lookup was
			* exact. 0.1.6-alpha.2 ends that guarantee: it mounts an embedded Conversation
			* in the sidebar, so a second composer — with its own session, its own dock
			* and its own dialog — can be live and open at the same time.
			*
			* There is no DOM link from a dialog back to its trigger (the portaled panel
			* carries no id and no `aria-controls`), so with two dialogs open document
			* order says nothing about ownership. The shape confirmation in
			* {@link dialogShapeMatches} would usually reject the stranger, but it compares
			* against THIS entry's counts, so a coincidentally matching dialog would be
			* priced with another session's figures. Ambiguity is therefore answered by
			* declining to decorate at all — the same rule the shape check already
			* follows, applied one level up: a dialog we cannot prove is ours is left
			* alone.
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
		* The shipped labels belong to the `chat` locale — they are `Uncached input` in
		* English and something else entirely in Chinese — so rows are matched by
		* POSITION, and this is what makes that safe: the row count must agree, the
		* cache-hit row must be the percentage it is, and every other value must carry
		* exactly the token count of the bucket predicted for it. A mismatch means the
		* dialog is not what this view describes, and nothing is decorated.
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
		* The OUTLET itself, not its parent. The outlet is one `display:contents` div
		* holding exactly this slot's entries (the shipped `stats` cell and ours), so it
		* is the narrowest container that is still per-composer. Its parent is NOT:
		* from 0.1.6-alpha.2 the composer stacks the dock inside a footer that also
		* holds the `ContextMeter`, whose trigger is another
		* `button[aria-haspopup="dialog"]` rendered after the dock — scoping to the
		* parent would let the cost land on the context ring.
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
		* Returned as a string rather than injected here so the modules stay free of
		* DOM side effects at import time: `./index.ts` installs it once, keyed by
		* `PAGE_CSS_ID`. It is a module of its own rather than a literal inside the
		* client entry so `tests/styles.test.ts` can audit every rule without importing
		* the React tree (which pulls `*.module.css` through the primitives package and
		* needs a loader registered first).
		*
		* Every colour comes from a harness theme alias with a neutral fallback, so the
		* page follows the active theme (light/dark and any brand pack) without
		* hardcoded values. Classes are `cc-` prefixed to stay clear of the panel's
		* `ccp-` set.
		*
		* @module dsh-commandcode-provider/client/page-styles
		*/
		/**
		* Stylesheet id (the `data-plugin-css` value that makes injection idempotent).
		*
		* The package prefix must match the one the panel stylesheet uses
		* (`PANEL_CSS_ID` in `./panel-styles.ts`) and this package's real name: an id is
		* the injection's identity, so a stale fork prefix would let a second copy of
		* the plugin inject the same rules twice and would misreport the owner in the
		* DOM. The two ids must also stay distinct from each other — they key two
		* separate style tags, and a shared id would make the second injection a no-op
		* that silently drops one stylesheet.
		*/
		const PAGE_CSS_ID = "@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css";
		/** The settings-page stylesheet. */
		const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.cc-title{margin:0;font-size:18px;font-weight:600}
.cc-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}
.cc-readOnly{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:4px 16px}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-reset:disabled{cursor:default;opacity:.5}
.cc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* The routing-rule model multi-select: a button trigger that opens an
 * anchored Menu of checkbox rows. The trigger mirrors .cc-input sizing so it
 * sits flush with the sibling account select. */
.cc-ruleTrigger{align-items:center;gap:8px;display:flex;width:100%;text-align:left;cursor:pointer}
.cc-ruleTrigger:disabled{cursor:default}
.cc-ruleTriggerText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-ruleCaret{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:6px;height:6px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg)}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
.cc-check{appearance:none;flex-shrink:0;width:15px;height:15px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:2px;left:5px;width:3px;height:7px;border:solid #fff;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The model multi-select search box: stacked under the trigger while the
 * dropdown is open, same input sizing so the pair reads as one control. The
 * box lives inside the Menu anchor (which renders inside the Menu's root
 * span), so focusing/typing it never trips the Menu's outside-click close. */
.cc-modelSelectAnchor{flex-direction:column;gap:6px;display:flex;width:100%}
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
/* Selects need their own treatment to sit flush with the text inputs:
 * the UA stylesheet renders <select> border-box (34px total vs the inputs'
 * 36px) and forces its own menulist text metrics, so drop the native
 * chrome entirely (appearance:none), restore content-box so the outer box
 * matches the inputs again, and draw the chevron ourselves. Longhand
 * background-* only — the shorthand would reset .cc-input's background. */
select.cc-input{appearance:none;-webkit-appearance:none;-moz-appearance:none;box-sizing:content-box;padding-right:32px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23888f98' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
.cc-inputInvalid{border-color:var(--dsw-alias-label-error)}
.cc-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
/* The Advanced card: its header row is one full-width toggle button; the
 * chevron is two borders on a rotated square (no icon dependency). */
.cc-advancedHead{align-items:center;gap:8px;display:flex;width:100%;padding:12px 0;background:0 0;border:none;cursor:pointer;font:inherit;text-align:left}
.cc-advancedHead:hover .cc-advancedTitle{color:var(--dsw-alias-label-primary)}
.cc-advancedTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.cc-advancedSpacer{flex:1}
.cc-chevron{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:8px;height:8px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg);transition:transform .15s ease}
.cc-chevronUp{transform:rotate(-135deg);margin-bottom:-3px}
.cc-advancedBody{flex-direction:column;display:flex}
.cc-advancedBody>.cc-field:first-of-type{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-toggleRow{align-items:center;gap:8px;cursor:pointer;display:flex}
.cc-toggleRow:has(.cc-toggle:disabled){cursor:default}
.cc-toggle{appearance:none;flex-shrink:0;background:var(--dsw-alias-border-l2);border-radius:999px;width:30px;height:18px;margin:0;cursor:pointer;position:relative;transition:background .15s ease}
.cc-toggle:checked{background:var(--dsw-alias-brand-primary)}
.cc-toggle::after{content:'';background:#fff;border-radius:50%;width:14px;height:14px;position:absolute;top:2px;left:2px;transition:left .15s ease}
.cc-toggle:checked::after{left:14px}
.cc-toggle:disabled{cursor:default;opacity:.5}
.cc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.cc-usageCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;flex-direction:column;gap:12px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usagePlan{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.cc-usagePlanStatus{white-space:nowrap;color:var(--dsw-alias-label-error);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usageRefresh{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-usageRefresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-usageRefresh:disabled{cursor:default;opacity:.5}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-usageError{align-items:center;gap:8px;color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;display:flex}
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex}
.cc-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.cc-usageStatSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageWindows{flex-direction:column;gap:16px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;font-weight:500;line-height:1.5}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:1.5}
.cc-usageExceeded{color:var(--dsw-alias-label-error);font-size:11px;font-weight:500;line-height:1.5}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:6px}
.cc-usageBarFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.cc-usageBarFillWarn{background:var(--dsw-alias-label-error)}
@media (prefers-reduced-motion:reduce){.cc-chevron,.cc-toggle,.cc-toggle::after,.cc-usageBarFill{transition:none}}.cc-usageWindowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usageMeta{align-items:center;gap:8px;display:flex}
.cc-accountReport{flex-direction:column;gap:12px;display:flex}
.cc-tabs{flex-wrap:wrap;gap:6px;display:flex}
.cc-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.cc-tab:hover:not(.cc-tabActive){color:var(--dsw-alias-label-primary)}
.cc-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-tabDotOk{background:var(--dsw-alias-brand-primary);border-radius:50%;width:6px;height:6px}
.cc-tabDotWarn{background:#d97706;border-radius:50%;width:6px;height:6px}
.cc-tabDotError{background:var(--dsw-alias-label-error);border-radius:50%;width:6px;height:6px}
.cc-usageMetaSpacer{flex:1}
.cc-usageUpdated{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usagePartial{color:var(--dsw-alias-label-error);margin:0;font-size:11px;line-height:1.5}
.cc-usageBlocked{border:1px solid var(--dsw-alias-label-error);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.cc-usageBlockedTitle{color:var(--dsw-alias-label-error);margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageBlockedHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}
.cc-usageBlockedDetail{color:var(--dsw-alias-label-secondary);margin:0;font-size:11px;line-height:1.5;word-break:break-word;opacity:.85}
.cc-version{margin:4px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
/* The Models-page provider panel root: unstyled by design — the row card the
 * Models page owns supplies the surface, the panel only stacks its controls. */
.cc-providerCard{flex-direction:column;display:flex}
/* The update hint rides the footer version line: warning-tinted (with a
 * muted fallback for themes without the alias), quiet until hovered. */
.cc-versionLink{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
/* The login panel rides the connection card as one more field row; the
 * authorization link is the only branded element on it. */
.cc-loginLink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;line-height:1.5}
.cc-loginLink:hover{text-decoration:underline;text-underline-position:under}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-label-error)}
.cc-saved{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;font-weight:500;line-height:1.5}
.cc-badgeWarn{background:var(--dsw-alias-state-warning-secondary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
`;
		//#endregion
		//#region src/client/panel-styles.ts
		/**
		* Stylesheet for the Command Code plans & quota panel (the sidebar footer card
		* and the dashboard it opens).
		*
		* Returned as a string rather than injected here so the modules stay free of
		* DOM side effects at import time — the client entry installs it once, keyed
		* by the same `data-plugin-css` attribute the settings-page stylesheet
		* (`./page-styles.ts`) uses, and removes it again when the plugin's fiber
		* unwinds.
		*
		* These rules are GLOBAL CSS: every selector in here can match markup this
		* plugin did not render. So each one is either qualified by a `ccp-` class of
		* our own, or anchored to the sidebar region it has to lay out — and the one
		* foreign anchor carries its justification in place (see the footer card
		* block; issue #48). `tests/styles.test.ts` audits that containment for both
		* stylesheets and simulates it against the real foreign class stems.
		*
		* Every colour comes from a harness theme alias with a neutral fallback, so
		* the panel follows the active theme (light/dark and any brand pack) without
		* hardcoded values. Classes are `ccp-` prefixed to stay clear of the settings
		* page's `cc-` set.
		*
		* @module dsh-commandcode-provider/client/panel-styles
		*/
		/**
		* Stylesheet id (the `data-plugin-css` value that makes injection idempotent).
		*
		* The package prefix must match the one the settings-page stylesheet uses
		* (`PAGE_CSS_ID` in `./page-styles.ts`) and this package's real name: an id is
		* the injection's identity, so a stale fork prefix would let a second copy of
		* the plugin inject the same rules twice and would misreport the owner in the
		* DOM. The two ids must also stay distinct from each other — they key two
		* separate style tags, and a shared id would make the second injection a no-op
		* that silently drops one stylesheet.
		*/
		const PANEL_CSS_ID = "@mars-sea/dsh-commandcode-provider/CommandCodePanel.module.css";
		/** The panel stylesheet. */
		const PANEL_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat, so the card
   is the sidebar's bottom-most content. The shell supplies no chrome: the entry
   is the button. It is deliberately quiet — a surface that sits beside Settings
   should read as part of the column, not as a call to action — with one hover
   step and a hairline border.

   The shell's container is a flex ROW whose occupants (this card and ui-cordis's
   footer chip) each declare a full-width line and shrink-proof flex, so as a row
   it would overflow the column: this card's flex:0 0 auto cannot shrink, and the
   chip's width:100% basis would absorb the whole overflow and collapse to
   nothing. Both were written for a full-width line, which is exactly what a
   column gives them. Matched by the CSS-module class STEM — never a hashed name
   — so a dsh that renames it degrades to the shell's own row rather than
   breaking.

   THE ANCHOR IS LOAD-BEARING, and it is the whole reason this selector is not
   just [class*="_footerActions"] (issue #48). "footerActions" is NOT a stem this
   shell owns alone: @deepseek-ai/dsh-client-ui-user-questions renders the
   ask-user-question dialog's button row as Mbwy4a_footerActions, so the
   unanchored rule forced THAT row into a column too and stacked the dialog's
   side-by-side buttons on every page. "footArea" is declared by
   dsh-client-ui-sidebar alone — verified against every client bundle of the
   0.1.6-alpha.1 engine, and against our own cc-/ccp- class names, which collide
   with no engine class — so anchoring under it keeps the sidebar layout fix and
   cannot reach another component's markup. The descendant combinator (rather
   than a child one) deliberately survives a wrapper element appearing between
   the two: a renamed or restructured shell should degrade to its own row, not
   lose the fix. tests/styles.test.ts pins both halves of this — the dialog row
   is no longer matched, the sidebar row still is. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.ccp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.ccp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ccp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.ccp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
/* One block per quota window: a head line carrying the window's own spend and
   limit, then the FULL-WIDTH bar under it. Stacking the two lets the card show
   the dollar figures — the reason this surface exists — without squeezing the
   bar into what is left beside them. Mirrors the dashboard's own window block. */
.ccp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.ccp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.ccp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.ccp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, not divs. That makes display:block
   load-bearing on BOTH: an inline box ignores width and height outright, so
   without it the 5px track still painted (a flex item is blockified by its
   container) while the fill collapsed to 0x0 and the bar showed no usage. */
.ccp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.ccp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell),
   so the collapsed column keeps a single 18px glyph like its siblings. */
.ccp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.ccp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ccp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph. Sized entirely by its own width/height attribute, so the
   footer row, the rail button and the dashboard can each ask for their own. */
.ccp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.ccp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.ccp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.ccp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.ccp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-spacer{flex:1}
.ccp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums}
/* The dashboard's exit: an icon-sized glyph button. The primitive's own
   geometry is kept (size="sm"); only the glyph is enlarged and optically
   centred, so it reads as a dismiss control rather than a text button. */
.ccp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0}
.ccp-close span{font-size:16px;line-height:1}
.ccp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

/* Notices: the no-key guidance, a blocked report, and a stale-data error. */
.ccp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.ccp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.ccp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.ccp-noticeError .ccp-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.ccp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.ccp-noticeDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;word-break:break-word}

.ccp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.ccp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.ccp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.ccp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.ccp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.ccp-block{flex-direction:column;gap:8px;display:flex}
.ccp-blockTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}
.ccp-planRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.ccp-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-planName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}

/* Stat tiles: the monthly credits and the usage totals share one grid. */
.ccp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.ccp-tile{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-tileLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.ccp-tileValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.ccp-tileSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota bars: the monthly bar and the two windows stack in one column, each a
   label row plus the track. */
.ccp-windows{flex-direction:column;gap:14px;display:flex}
.ccp-window{flex-direction:column;gap:6px;display:flex}
.ccp-windowHead{align-items:baseline;gap:8px;display:flex}
.ccp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.ccp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.ccp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.ccp-warnTag{white-space:nowrap;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border-radius:999px;padding:0 8px;font-size:11px;font-weight:600;line-height:17px}
.ccp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.ccp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}

/* Badges. */
.ccp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.ccp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.ccp-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.ccp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Account switch: plain buttons, like the settings page's usage carousel. */
.ccp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.ccp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.ccp-tab:hover:not(.ccp-tabActive){color:var(--dsw-alias-label-primary)}
.ccp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (prefers-reduced-motion:reduce){.ccp-footFill,.ccp-barFill{transition:none}}
`;
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			nav: "Command Code",
			title: "Command Code",
			intro: "配置 Command Code Provider 连接。API 密钥仅保存在本机凭据服务中，不会回显；其他字段写入用户设置，下次请求即生效。",
			apiKey: "API 密钥",
			apiKeyHint: "在 commandcode.ai 控制台创建。留空保存不会覆盖已存储的密钥。",
			apiKeySet: "已配置",
			apiKeyUnset: "未配置",
			apiKeyLocked: "密钥由只读来源提供",
			apiBase: "API 地址",
			apiBaseHint: "默认 https://api.commandcode.ai，一般无需修改。",
			workingDir: "工作目录",
			workingDirHint: "可选。留空时使用占位符显示的进程工作目录；仅在需要固定路径时填写。",
			requestTimeoutMs: "请求超时（毫秒）",
			requestTimeoutMsHint: "等待响应首个字节的超时；默认 60000。",
			streamIdleTimeoutMs: "流空闲超时（毫秒）",
			streamIdleTimeoutMsHint: "生成流停滞多久视为断连；默认 300000（长思考模型可静默数分钟，默认值刻意放宽）。",
			transportMaxRetries: "网络失败重试次数",
			transportMaxRetriesHint: "连接失败时自动重试几次，默认 5（各次等待 0.5+1+2+4+8 秒，合计约 15 秒）。超过后直接报错，不再按指数退避长时间等待；填 0 表示不重试。限流、5xx 等由服务端要求重试的失败不受此项影响。",
			advancedSettings: "高级设置",
			advancedSettingsHint: "API 地址、工作目录、超时、模型过滤、联网搜索与侧边栏额度卡片等不常修改的选项。",
			advancedOverriddenOne: "已自定义 1 项",
			advancedOverriddenMany: "已自定义 {count} 项",
			advancedInvalid: "高级设置中有未填好的数字，请展开修正后再保存。",
			filterModelsByPlan: "隐藏套餐外模型",
			filterModelsByPlanHint: "开启后，模型选择器只列出当前套餐可用的模型；账户持有按需余额时会显示全部。",
			webSearch: "用 Command Code 承载联网搜索",
			webSearchHint: "开启后，dsh 的 web_search 工具由 Command Code 承担（复用同一个 API key 与地址），并优先于其他搜索后端；关闭则把选择权交还给之前的后端（如 modsearch），而不是强制回退到 DeepSeek 搜索。",
			showSidebarQuota: "在侧边栏显示额度卡片",
			showSidebarQuotaHint: "开启后，侧边栏底部（Settings 上方）显示 Command Code 套餐与配额卡片，点击可在中间栏打开完整仪表盘。默认关闭：左侧不显示任何额度信息，也不会为其后台刷新用量。保存后立即生效。",
			accountsTitle: "多账户轮换",
			accountsHint: "当前账户达到用量限额（429）或密钥失效（401）时，请求自动切换到下一个账户；全部耗尽时会提示最早的重置时间。",
			accountAdd: "添加账户",
			accountRemove: "移除",
			accountLabel: "账户备注名",
			accountKey: "API 密钥",
			accountKeyHint: "该账户的 API 密钥。留空保存不会覆盖已存储的密钥。",
			accountDefault: "默认账户",
			activeAccount: "当前使用账户",
			activeAccountAuto: "自动（第一个可用账户）",
			activeAccountHint: "手动指定优先使用的账户，保存后下次请求即生效；所选账户耗尽时仍会自动切换到其他可用账户。",
			rulesTitle: "按模型切换账户",
			rulesHint: "选择模型并路由到某个账户（可多选）。命中规则的模型且该账户可用时优先使用；账户耗尽或密钥失效时仍自动回落到其他账户。规则按列表顺序匹配，第一条命中生效。",
			rulesEmpty: "尚未配置规则。",
			rulesCatalogFailed: "模型目录获取失败，暂时无法选择模型；已保存的规则仍会生效。",
			ruleAdd: "添加规则",
			ruleRemove: "移除",
			ruleModel: "模型",
			ruleModelPick: "选择模型…",
			ruleModelCount: "已选 {count} 个模型",
			ruleAccount: "目标账户",
			ruleHint: "从下拉列表勾选要路由的模型（可多选），再选择目标账户。",
			modelSearchPlaceholder: "搜索模型…",
			modelSearchEmpty: "没有匹配的模型。",
			modelStale: "已下架",
			visibleModelsTitle: "模型白名单",
			visibleModelsHint: "勾选要保留的模型，模型选择器就只列出这些；一个都不勾选时则显示全部模型。保存后，下次打开模型选择器生效。",
			visibleModelsPick: "选择要保留的模型…",
			visibleModelsCount: "已选 {count} 个模型",
			visibleModelsShowAll: "显示全部",
			visibleModelsStaleHint: "有 {count} 个已选模型在目录中找不到了（可能已下架），不影响其他模型；可清理或保留。",
			visibleModelsCleanStale: "清理失效（{count}）",
			overridden: "已覆盖",
			reset: "重置",
			invalidNumber: "无效数字",
			numberTooSmall: "不能小于 1（毫秒）",
			numberTooLarge: "超出允许上限（2147483647 毫秒）",
			readOnly: "当前配置为只读。",
			unsaved: "未保存",
			save: "保存",
			saving: "保存中",
			saved: "已保存 ✓",
			saveFailed: "保存失败，请重试。",
			discard: "放弃",
			cancel: "取消",
			show: "显示",
			hide: "隐藏",
			usageTitle: "账户用量",
			usageRefresh: "刷新",
			usageRefreshing: "刷新中…",
			usageLoading: "正在获取账户用量…",
			usageNoKey: "配置 API 密钥后，这里会显示账户的用量与额度状态。",
			usageError: "用量获取失败",
			usageRequests: "请求",
			usageFailed: "失败",
			usageSuccessRate: "成功率",
			usageCost: "花费",
			usageTokens: "Token",
			usageTokensIn: "入",
			usageTokensOut: "出",
			usageMonthly: "月额度",
			usagePurchased: "已购",
			usageFree: "赠送",
			usageFiveHour: "5 小时窗口",
			usageWeekly: "每周窗口",
			usageExceeded: "已超限",
			usageReset: "重置于",
			usagePartial: "部分端点数据不可用",
			usageKeyClear: "清除已存密钥",
			usageKeyClearStaged: "将清除（保存后生效）",
			usageUndoKeyClear: "撤销清除",
			usageKeyInvalid: "API 密钥无效或已过期",
			usageKeyInvalidHint: "服务端拒绝了全部请求（401）。请检查该账户配置的密钥，或到 commandcode.ai 控制台重新生成。",
			usageServiceUnavailable: "Command Code 服务暂时不可用",
			usageServiceUnavailableHint: "服务端返回了错误（5xx），稍后点击刷新重试。",
			usageNetworkError: "无法连接 Command Code 服务",
			usageNetworkHint: "所有请求都没有到达服务端。请检查网络连接或 API 地址设置。",
			usageUpdated: "更新于",
			usagePeriodEnd: "账期截止",
			usageActive: "当前使用",
			usageCooldown: "限额冷却中",
			usageInvalidKey: "密钥无效",
			usageUnconfigured: "该账户尚未配置 API 密钥。",
			updateAvailable: "可更新",
			updateHint: "已发布新版本，点击查看发布说明；更新插件后刷新本页，提示会自动消失。",
			loginTitle: "通过官方登录获取密钥",
			loginHintIdle: "不想手动创建密钥？点击登录后浏览器会打开 commandcode.ai 授权页，完成后密钥自动写入本机凭据服务，下次请求即生效。",
			loginButton: "登录 Command Code",
			loginStarting: "正在启动本地回调服务…",
			loginWaiting: "等待在浏览器中完成授权…",
			loginOpenLink: "打开授权页面 ↗",
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
			cardRegistrationHint: "此卡片随 Command Code 插件注册，需要较新版本的 DeepSeek Harness 才会显示完整内容。"
		};
		const en = {
			nav: "Command Code",
			title: "Command Code",
			intro: "Configure the Command Code Provider connection. The API key is stored only in the local credential service and never echoed; other fields are written to user settings and take effect on the next request.",
			apiKey: "API key",
			apiKeyHint: "Create one in the commandcode.ai console. Saving with this field blank keeps the stored key.",
			apiKeySet: "Configured",
			apiKeyUnset: "Not configured",
			apiKeyLocked: "Key provided by a read-only source",
			apiBase: "API base URL",
			apiBaseHint: "Defaults to https://api.commandcode.ai; usually leave as-is.",
			workingDir: "Working directory",
			workingDirHint: "Optional. Leave blank to use the process cwd shown as the placeholder; fill in only to pin a specific path.",
			requestTimeoutMs: "Request timeout (ms)",
			requestTimeoutMsHint: "Time to wait for the first response byte; default 60000.",
			streamIdleTimeoutMs: "Stream idle timeout (ms)",
			streamIdleTimeoutMsHint: "How long a stalled stream is treated as dead; default 300000 (deliberately generous — long-thinking models can stay silent for minutes).",
			transportMaxRetries: "Transport retries",
			transportMaxRetriesHint: "How many times a failed connection is retried automatically; default 5 (waits of 0.5+1+2+4+8s, ~15s in total). After that the failure is reported instead of waiting on the exponential backoff. 0 disables the retries. Rate limits and 5xx answers keep their own, longer retry window.",
			advancedSettings: "Advanced",
			advancedSettingsHint: "Rarely touched options: API base URL, working directory, timeouts, model filtering, web search, and the sidebar quota card.",
			advancedOverriddenOne: "1 customized",
			advancedOverriddenMany: "{count} customized",
			advancedInvalid: "A number in Advanced settings is not ready to save; expand to fix it.",
			filterModelsByPlan: "Hide out-of-plan models",
			filterModelsByPlanHint: "When on, the model picker lists only models your subscription includes; any on-demand credit balance shows the full catalog.",
			webSearch: "Serve dsh web search with Command Code",
			webSearchHint: "When on, the model-facing web_search tool is backed by Command Code (same API key and base URL as chat), winning over other search backends. Off hands the selection back to the previous backend (e.g. modsearch) instead of forcing the shipped DeepSeek search.",
			showSidebarQuota: "Show the quota card in the sidebar",
			showSidebarQuotaHint: "When on, a Command Code plan & quota card sits at the bottom of the sidebar (above Settings) and opens the full dashboard in the centre column. Off by default: nothing is shown on the left, and no background usage poll runs for it. Applies on save.",
			accountsTitle: "Account rotation",
			accountsHint: "When the active account hits its usage limit (429) or its key fails (401), requests switch to the next account; when every account is exhausted the error names the earliest window reset.",
			accountAdd: "Add account",
			accountRemove: "Remove",
			accountLabel: "Account label",
			accountKey: "API key",
			accountKeyHint: "This account’s API key. Saving with the field blank keeps the stored key.",
			accountDefault: "Default account",
			activeAccount: "Active account",
			activeAccountAuto: "Auto (first usable account)",
			activeAccountHint: "Pin the preferred account; applies to the next request after saving. If the selected account is exhausted, requests still rotate to another usable account.",
			rulesTitle: "Route models to accounts",
			rulesHint: "Pick models (multi-select) and route them to an account. When the request’s model is in a rule and that account is usable, it serves; an exhausted or invalid routed account falls back to the normal rotation. Rules match in list order — the first hit wins.",
			rulesEmpty: "No rules yet.",
			rulesCatalogFailed: "Could not load the model catalog — selecting models is unavailable; saved rules still apply.",
			ruleAdd: "Add rule",
			ruleRemove: "Remove",
			ruleModel: "Models",
			ruleModelPick: "Select models…",
			ruleModelCount: "{count} model(s) selected",
			ruleAccount: "Target account",
			ruleHint: "Check the models to route from the dropdown (multi-select), then pick the target account.",
			modelSearchPlaceholder: "Search models…",
			modelSearchEmpty: "No matching models.",
			modelStale: "Retired",
			visibleModelsTitle: "Model allowlist",
			visibleModelsHint: "Check the models you want to keep, and model pickers will list only those. If nothing is checked, every model is shown. After saving, the change applies the next time you open a model picker.",
			visibleModelsPick: "Select models to keep…",
			visibleModelsCount: "{count} model(s) selected",
			visibleModelsShowAll: "Show all",
			visibleModelsStaleHint: "{count} selected model(s) are no longer in the catalog (possibly retired); other models are unaffected. Clean them up or keep them.",
			visibleModelsCleanStale: "Clean stale ({count})",
			overridden: "Overridden",
			reset: "Reset",
			invalidNumber: "Invalid number",
			numberTooSmall: "Must be at least 1 (ms)",
			numberTooLarge: "Above the allowed maximum (2147483647 ms)",
			readOnly: "Settings are read-only.",
			unsaved: "Unsaved",
			save: "Save",
			saving: "Saving",
			saved: "Saved ✓",
			saveFailed: "Save failed, please retry.",
			discard: "Discard",
			cancel: "Cancel",
			show: "Show",
			hide: "Hide",
			usageTitle: "Account usage",
			usageRefresh: "Refresh",
			usageRefreshing: "Refreshing…",
			usageLoading: "Fetching account usage…",
			usageNoKey: "Configure an API key to see this account’s usage and credit state here.",
			usageError: "Could not fetch usage",
			usageRequests: "Requests",
			usageFailed: "failed",
			usageSuccessRate: "Success rate",
			usageCost: "Spend",
			usageTokens: "Tokens",
			usageTokensIn: "in",
			usageTokensOut: "out",
			usageMonthly: "Monthly",
			usagePurchased: "Purchased",
			usageFree: "Free",
			usageFiveHour: "5-hour window",
			usageWeekly: "Weekly window",
			usageExceeded: "Exceeded",
			usageReset: "Resets",
			usagePartial: "Some endpoint data unavailable",
			usageKeyClear: "Clear stored key",
			usageKeyClearStaged: "Will be cleared on save",
			usageUndoKeyClear: "Undo clear",
			usageKeyInvalid: "API key invalid or expired",
			usageKeyInvalidHint: "The server rejects every request (401). Check the key configured for this account, or generate a new one in the commandcode.ai console.",
			usageServiceUnavailable: "The Command Code service is temporarily unavailable",
			usageServiceUnavailableHint: "The server returned errors (5xx); try Refresh again later.",
			usageNetworkError: "Could not reach the Command Code service",
			usageNetworkHint: "No request reached the server. Check your network connection or the API base setting.",
			usageUpdated: "Updated",
			usagePeriodEnd: "Period ends",
			usageActive: "Active",
			usageCooldown: "Cooling down",
			usageInvalidKey: "Invalid key",
			usageUnconfigured: "No API key configured for this account yet.",
			updateAvailable: "update available",
			updateHint: "A newer version has been published; click for release notes. The notice disappears once the plugin is updated.",
			loginTitle: "Sign in to fetch a key",
			loginHintIdle: "Rather not create a key by hand? Sign in and your browser opens the commandcode.ai authorization page; the approved key is stored in the local credential service and applies to the next request.",
			loginButton: "Sign in to Command Code",
			loginStarting: "Starting the local callback server…",
			loginWaiting: "Waiting for authorization in your browser…",
			loginOpenLink: "Open the authorization page ↗",
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
			cardRegistrationHint: "This card is contributed by the Command Code plugin; a newer DeepSeek Harness is needed to show the full controls."
		};
		//#endregion
		//#region src/client/index.ts
		/** Inject the page stylesheet once (idempotent per tag). */
		function injectPageCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@mars-sea/dsh-commandcode-provider";
			tag.dataset.pluginCss = PAGE_CSS_ID;
			tag.textContent = PAGE_CSS;
			document.head.appendChild(tag);
		}
		/**
		* Install the plans & quota panel's stylesheet and return its disposer, for
		* `ctx.effect` to own. Keyed by its own `data-plugin-css` id, so the injection
		* is idempotent even if a second surface asks for it later.
		*/
		function injectPanelCss() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="@mars-sea/dsh-commandcode-provider/CommandCodePanel.module.css"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "@mars-sea/dsh-commandcode-provider";
			tag.dataset.pluginCss = PANEL_CSS_ID;
			tag.textContent = PANEL_CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/**
		* Plans & quota panel id. It is the layout's `MainPanelId`: one string shared
		* by the `sidebar.footer.action` card and the `main` slot cell, so the card
		* selects this panel and nothing else. `dsh-client-ui-layout` is not a
		* dependency of this bundle (its type is only a brand over `string`), so the
		* brand is applied at the call site instead of importing the package.
		*/
		const PANEL_ID = "commandcode-panel";
		/**
		* ui-conversation's reserved `main` key, used only as the exit fallback for a
		* layout whose `selectPanel` predates the `null` "show the Conversation"
		* selection (see `close` in {@link applyClientSurfaces}). Declared locally for
		* the same reason as {@link PANEL_ID}: ui-conversation is not a dependency of
		* this bundle, and the key is a published contract of the layout (its README
		* names `conversation` as reserved for the Conversation).
		*/
		const CONVERSATION_PANEL_ID = "conversation";
		/**
		* The composer figure's entry id in `conversation.composer.dock`. Its own id,
		* not the shipped `stats` cell's: reusing `stats` would REPLACE the tokens /
		* cache-hit / throughput readout rather than inject into it, and that readout
		* is the harness's to format (see `./session-cost-display.ts`).
		*/
		const SESSION_COST_ID = "commandcode-session-cost";
		/**
		* Client plugin body. Gates on the services shared by both client generations
		* (`slots`, `locale`, `connection`, `remote`) — never on `settingsScope`,
		* which 0.1.7 removed and which the settings scope here replaces for every
		* generation. Current clients mount the page after `remote.credentials`
		* appears; legacy clients mount it from the connection ApiProxy credential
		* face.
		*/
		function apply(ctx) {
			injectPageCss();
			ctx.effect(() => ctx.locale.register("settings.commandcode", {
				zh,
				en
			}), "dsh-commandcode-provider: page copy");
			ctx.effect(() => ctx.locale.register(PANEL_LOCALE_NS, {
				zh: PANEL_COPY_ZH,
				en: PANEL_COPY_EN
			}), "dsh-commandcode-provider: panel copy");
			const connection = ctx.get("connection");
			const legacyApi = adaptLegacyCredentials(connection?.api?.credentials);
			if (legacyApi !== void 0) {
				applyClientSurfaces(ctx, legacyApi, connection?.hostDescription);
				return;
			}
			ctx.inject(["remote.credentials"], (remoteCtx) => {
				const credentials = remoteCtx.remote.credentials;
				applyClientSurfaces(remoteCtx, { credentials });
			});
		}
		/** Mount the one shared UI implementation over either credential transport. */
		function applyClientSurfaces(ctx, api, hostDescription) {
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
			}, hostDescription);
			ctx.effect(() => () => controller.dispose(), "dsh-commandcode-provider: settings controller");
			const store = createSnapshotStore(controller.state());
			controller.subscribe(() => store.set(controller.state()));
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", () => {
				controller.refreshCredentials();
			}), "dsh-commandcode-provider: credential invalidations");
			let usageNamespace;
			let usageMountError;
			let pricesController;
			let refreshUsage;
			const contribution = {
				package: USAGE_REMOTE_CONTRIBUTION.package,
				descriptors: [
					...USAGE_REMOTE_CONTRIBUTION.descriptors,
					...MODELS_REMOTE_CONTRIBUTION.descriptors,
					...PRICES_REMOTE_CONTRIBUTION.descriptors,
					...LOGIN_REMOTE_CONTRIBUTION.descriptors
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
						refreshUsage?.();
						namespaceCtx.effect(() => () => {
							usageNamespace = void 0;
						}, "dsh-commandcode-provider: usage namespace");
					});
				}, (error) => {
					usageMountError = error instanceof Error ? error.message : String(error);
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
			const loginRemote = {
				loginBegin: async () => {
					if (usageNamespace === void 0) return {
						ok: false,
						error: { message: usageMountError ?? "commandcode remote is not mounted" }
					};
					return usageNamespace.loginBegin();
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
			const injected = () => ({
				hooks: {
					commandCodeSettings: store,
					commandCodeUsage: usageStore,
					commandCodeLogin: loginStore
				},
				edit: (field, text) => controller.edit(field, text),
				resetField: (field) => controller.resetField(field),
				save: () => void controller.save().then(() => {
					const settled = controller.state();
					if (!settled.failed && settled.anyAccountConfigured) usageController.refresh();
				}),
				discard: () => controller.discard(),
				refreshUsage: () => void usageController.refresh(),
				beginLogin: () => void loginController.begin(),
				cancelLogin: () => void loginController.cancel(),
				addAccount: () => controller.addAccount(),
				removeAccount: (id) => controller.removeAccount(id),
				editAccountLabel: (id, text) => controller.editAccountLabel(id, text),
				editAccountKey: (id, text) => controller.editAccountKey(id, text),
				toggleKeyClear: (id) => controller.toggleKeyClear(id),
				addRule: () => controller.addRule(),
				removeRule: (id) => controller.removeRule(id),
				editRuleModels: (id, ids) => controller.editRuleModels(id, ids),
				editRuleAccount: (id, text) => controller.editRuleAccount(id, text),
				editVisibleModels: (ids) => controller.editVisibleModels(ids),
				clearVisibleModels: () => controller.clearVisibleModels()
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
					save: () => void controller.save().then(() => {
						const settled = controller.state();
						if (!settled.failed && settled.anyAccountConfigured) usageController.refresh();
					}),
					discard: () => controller.discard(),
					beginLogin: () => void loginController.begin(),
					cancelLogin: () => void loginController.cancel()
				})
			}, CommandCodeProviderCard));
			const panelFace = () => ({
				hooks: {
					commandCodeUsage: usageStore,
					commandCodeSettings: store
				},
				refresh: () => {
					pricesController?.ensure();
					usageController.refresh();
				},
				startAutoRefresh: () => startPanelAutoRefresh(usageController, () => true),
				open: () => {
					const layout = ctx.get("layout");
					if (typeof layout?.selectPanel === "function") layout.selectPanel(PANEL_ID);
				},
				close: () => {
					const layout = ctx.get("layout");
					if (typeof layout?.selectPanel !== "function") return;
					try {
						layout.selectPanel(null);
					} catch {
						try {
							layout.selectPanel(CONVERSATION_PANEL_ID);
						} catch (error) {
							console.error("[dsh-commandcode-provider] could not close the plans & quota panel:", error);
						}
					}
				}
			});
			ctx.effect(() => injectPanelCss(), "dsh-commandcode-provider: panel styles");
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
				if (typeof layoutCtx.get("layout")?.selectPanel !== "function") return;
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
			"connection",
			"remote"
		];
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map