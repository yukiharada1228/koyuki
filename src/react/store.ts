export interface ViewStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
/** Cache snapshots at the adapter boundary; the core runtime remains unchanged. */
export function viewStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next: T) { if (Object.is(value, next)) return; value = next; for (const listener of listeners) listener(); },
  };
}
