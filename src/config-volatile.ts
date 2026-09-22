/**
 * Volatile-config bridge — the seam between dsh's two config generations.
 *
 * dsh 0.1.7 rewrote settings around profile Config: `settings.describe()`
 * projects each active entry's schema through `volatileForm()`, so a form
 * contains ONLY fields whose schema nodes carry `meta.volatile`, and a form
 * edit is refused unless its path lies beneath a marked node. On that
 * generation the loader resolves each marked top-level field into a readonly
 * `Volatile<T>` reference (`{ get() }`, frozen, written in place by the owning
 * runtime) instead of a plain value, commits later changes WITHOUT remounting
 * the fiber, and dispatches `loader/volatile-update` to the owning fiber.
 *
 * Older engines know neither mechanism: schemastery < 3.18.3 has no
 * `.volatile()` method at all, and where the mark can be applied but the
 * loader predates volatile config, `meta.voltage` is inert metadata and
 * `apply()` still receives plain values (settings writes reach the plugin
 * through the ≤0.1.6 settings document instead).
 *
 * Two helpers keep the rest of the plugin reading a PLAIN `Config`:
 *
 * - `markVolatile(schema)` calls `.volatile()` when the installed schemastery
 *   exposes it and returns the schema untouched otherwise, so schema
 *   construction never throws on an old engine while 0.1.7's forms see every
 *   field we mark. The method is typed structurally, never imported from
 *   schemastery, because the checkout pins 3.18.2 (no such member) while the
 *   0.1.7 engine ships 3.18.3.
 * - `unwrapVolatileConfig(config)` reads every top-level field through its
 *   reference when one is present — returning a FRESH object per call, since
 *   a reference's identity is stable while its value changes — and returns the
 *   config untouched when none is, which preserves object identity for the
 *   adapter-options memo on plain-config engines.
 *
 * Only TOP-LEVEL fields are marked (form writes name top-level paths such as
 * `accounts` or `modelVisibility.<id>`, whose first segment is the marked
 * node), so one unwrap level is complete. The literal `apiKey` secret stays
 * unmarked on purpose: no settings surface writes it — the settings page and
 * the dsh-TUI section both write keys through the credentials seam — so it
 * keeps composition-only semantics, and a config-file edit to it reloading the
 * fiber is the correct behavior for a secret literal.
 *
 * **The marks are for the 0.1.7 generation ONLY, and the legacy settings
 * registration must never see them.** schemastery creates the frozen
 * `{ get() }` references during PARSE on every generation — `dsh-settings`
 * through 0.1.6 declares `schemastery: ^3.18.2`, so a fresh install of an old
 * engine resolves 3.18.3 and its `apply(ctx, config)` receives references
 * too — while ≤0.1.6's `installSection` re-validates the base it is handed
 * (`resolve()` calls the schema on it) and its `describe()` structuredClones
 * that base. A marked schema plus a reference-carrying base therefore throws
 * `ValidationError` at BOOT on those engines (`expected boolean but got
 * [object Object]`), or `DataCloneError` when the directory is read. That is
 * why `src/index.ts` builds the fields twice: the exported `Config` with the
 * marks (loader + 0.1.7 forms) and `LegacySettingsSchema` without them, and
 * hands the legacy service an unwrapped base.
 *
 * @module dsh-commandcode-provider/config-volatile
 */

/** The one schemastery member this module needs, typed structurally. */
interface MarkableSchema {
  volatile?: (() => unknown) | undefined
}

/**
 * Mark one schema field volatile when the installed schemastery supports it.
 * @param schema - The field schema (any generation).
 * @returns The schema carrying `meta.volatile`, or the schema itself on an
 * engine whose schemastery predates `.volatile()`.
 */
export function markVolatile<S>(schema: S): S {
  const candidate = schema as S & MarkableSchema
  if (typeof candidate.volatile !== 'function') return schema
  return candidate.volatile() as S
}

/**
 * Mark every field of a Config field dict volatile, except the named
 * composition-only secrets (`apiKey` here, which no settings surface writes).
 *
 * The result is a NEW dict of schema instances: callers that also need an
 * UNMARKED schema for the legacy settings generation must build the fields
 * twice (`configFields()`), never share one dict — `.volatile()` clones per
 * call, and a shared instance would carry the mark into the legacy schema.
 *
 * @param fields - Freshly built field schemas.
 * @param skip - Field names that must stay unmarked.
 * @returns The field dict with every non-skipped field marked.
 */
export function markVolatileFields<D extends Record<string, unknown>>(
  fields: D,
  skip: readonly string[] = [],
): D {
  return Object.fromEntries(
    Object.entries(fields).map(([name, schema]) => [name, skip.includes(name) ? schema : markVolatile(schema)]),
  ) as D
}

/** A resolved volatile config reference: the frozen `{ get() }` cosmokit hands out. */
export interface VolatileRef {
  get(): unknown
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
export function isVolatileRef(value: unknown): value is VolatileRef {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.isFrozen(value)
    && typeof (value as VolatileRef).get === 'function'
}

/**
 * Read one config object as PLAIN values across generations.
 *
 * Each top-level field found to be a volatile reference is read through
 * `.get()` — freshly on every call, so a live update lands on the very next
 * read. When no field is a reference the input object is returned as-is,
 * keeping reference identity stable for identity-keyed memos on engines that
 * hand `apply()` plain config.
 */
export function unwrapVolatileConfig<C>(config: C): C {
  const source = config as C & Record<string, unknown>
  if (typeof source !== 'object' || source === null) return config
  let found = false
  const plain: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(source)) {
    if (isVolatileRef(value)) {
      plain[field] = value.get()
      found = true
    } else {
      plain[field] = value
    }
  }
  return (found ? plain : config) as C
}
