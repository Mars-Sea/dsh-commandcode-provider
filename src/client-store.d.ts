/** Compile-time face of the DSH 0.1.2 browser platform store module. */
declare module '@deepseek-ai/dsh-client-store' {
  /** Mutable observable snapshot consumed by slot hooks. */
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
    set(value: T): void
  }

  /** Create one observable snapshot store. */
  export function createSnapshotStore<T>(initial: T): SnapshotStore<T>
}

/** Type-only module marker for the 0.1.2 renderer service augmentation. */
declare module '@deepseek-ai/dsh-client-ui-renderer/client'
