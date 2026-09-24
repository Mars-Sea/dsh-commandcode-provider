/**
 * A tiny observable snapshot store — the `getSnapshot` / `subscribe` / `set`
 * triple React's `useSyncExternalStore` consumes through the harness slot kit
 * (the host builds each slot's `useFoo(selector)` hook from one of these).
 *
 * Vendored on purpose, and small enough to stay that way: the harness's
 * `@deepseek-ai/dsh-client-store` is a seeded platform module, but pulling it in
 * would add a fourth `require()` target (and a client-only peer) to the bundle
 * for the ~30 lines used here, and its `set()` carries engine semantics
 * (dev-mode deep freeze, forced replacement) these callers do not want.
 */

/** Mutable observable snapshot consumed by slot hooks. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

/** Notify every subscriber without letting one faulty UI consumer suppress the rest. */
function notifyListeners(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error: unknown) {
      console.error('[dsh-commandcode-provider] snapshot subscriber failed:', error)
    }
  }
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
      notifyListeners(listeners)
    },
  }
}
