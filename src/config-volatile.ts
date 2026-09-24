/**
 * Volatile-config helpers for dsh 0.1.7's schema-derived profile Config.
 *
 * 0.1.7 rewrote settings around profile Config: `settings.describe()` projects
 * each active entry's schema through `volatileForm()`, so a form contains ONLY
 * fields whose schema nodes carry `meta.volatile`, and a form edit is refused
 * unless its path lies beneath a marked node. On that generation the loader
 * resolves each marked top-level field into a readonly `Volatile<T>` reference
 * (`{ get() }`, frozen, written in place by the owning runtime) instead of a
 * plain value, commits later changes WITHOUT remounting the fiber, and
 * dispatches `loader/volatile-update` to the owning fiber.
 *
 * Two helpers keep the rest of the plugin reading a PLAIN `Config`:
 *
 * - `markVolatile(schema)` applies `.volatile()`, so 0.1.7's forms see every
 *   field we mark. The declared type is preserved through the mark on purpose:
 *   it changes what the schema PARSES to (a live reference), not the
 *   plugin-facing `Config` shape every consumer reads.
 * - `unwrapVolatileConfig(config)` reads every top-level field through its
 *   reference when one is present — returning a FRESH object per call, since
 *   a reference's identity is stable while its value changes — and returns the
 *   config untouched when none is.
 *
 * Only TOP-LEVEL fields are marked (form writes name top-level paths such as
 * `accounts` or `modelVisibility.<id>`, whose first segment is the marked
 * node), so one unwrap level is complete. The literal `apiKey` secret stays
 * unmarked on purpose: no settings surface writes it — the settings page and
 * the dsh-TUI section both write keys through the credentials seam — so it
 * keeps composition-only semantics, and a config-file edit to it reloading the
 * fiber is the correct behavior for a secret literal.
 *
 * @module dsh-commandcode-provider/config-volatile
 */

/**
 * Mark one schema field volatile.
 *
 * `.volatile()` is unconditional: the mark is a schemastery 3.18.3 feature and
 * the only engine this bundle supports (`dsh 0.1.7-rc.1`) pins `~3.18.4`, so
 * the method is always present. It is reached through a structural member
 * rather than schemastery's own typing so the function can keep the caller's
 * declared field type, which is what lets `Config` stay the plain shape every
 * consumer reads while the schema parses to live references.
 *
 * @param schema - The field schema.
 * @returns The schema carrying `meta.volatile`.
 */
export function markVolatile<S>(schema: S): S {
  return (schema as S & { volatile(): S }).volatile()
}

/**
 * Mark every field of a Config field dict volatile, except the named
 * composition-only secrets (`apiKey` here, which no settings surface writes).
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
 * Read one config object as PLAIN values.
 *
 * Every top-level field found to be a volatile reference is read through
 * `.get()` — freshly on every call, so a live update lands on the very next
 * read. The loader resolves EVERY marked node into a reference, unset fields
 * included, so a loader-parsed config always yields a fresh object here; the
 * pass-through for a field that is not a reference is what keeps the unmarked
 * `apiKey` literal readable.
 */
export function unwrapVolatileConfig<C>(config: C): C {
  const source = config as C & Record<string, unknown>
  if (typeof source !== 'object' || source === null) return config
  const plain: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(source)) {
    plain[field] = isVolatileRef(value) ? value.get() : value
  }
  return plain as C
}
