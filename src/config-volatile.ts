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
 * only supported engine (`dsh 0.1.7-rc.2`) pins `~3.18.4`, so the method is
 * always present. It is reached through a structural member so the caller's
 * declared field type survives — the mark changes what the schema PARSES to (a
 * live reference), not the plugin-facing `Config` shape.
 */
export function markVolatile<S>(schema: S): S {
  return (schema as S & { volatile(): S }).volatile()
}

/**
 * Mark every field of a Config field dict volatile, except the named
 * composition-only secrets (`apiKey` here, which no settings surface writes).
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
 * read (the loader resolves EVERY marked node into a reference, unset fields
 * included, so a loader-parsed config always yields a fresh object here). The
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
