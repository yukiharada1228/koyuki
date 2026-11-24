import { useSyncExternalStore } from 'react';
import type { ViewStore } from './store.js';
export function useProgramView<T>(store: ViewStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
