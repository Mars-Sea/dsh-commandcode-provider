/**
 * A tiny observable snapshot store — the `getSnapshot` / `subscribe` / `set`
 * triple React's `useSyncExternalStore` consumes through the harness slot kit
 * (the host builds each slot's `useFoo(selector)` hook from one of these).
 *
 * Vendored on purpose. The 0.1.2 adapter used to import this from the
 * `@deepseek-ai/dsh-client-store` platform module, but that package was never
 * published to the registry and the host's client-module table does not
 * materialize it — so any `require("@deepseek-ai/dsh-client-store")` in the
 * built client bundle makes the dsh loader reject the whole plugin at import
 * time. The utility is small enough (and behaviorally identical to the
 * platform one — notify-on-set, stable-while-unchanged) that inlining it
 * removes a hard dependency on a not-yet-shipped module without changing the
 * slot-hook contract. When the platform module lands upstream we can flip
 * back to importing it; until then this keeps the plugin loadable.
 */

/** Mutable observable snapshot consumed by slot hooks. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

/** Create one observable snapshot store. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value: T) {
      if (Object.is(value, snapshot)) return
      snapshot = value
      for (const listener of listeners) {
        listener()
      }
    },
  }
}
