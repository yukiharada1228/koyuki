import type { procurement } from './application.js';
import type { StorageError, ProcurementRepository } from './repository.js';
import type { Actor, Policy } from './domain.js';
type Tables<E> = ReturnType<typeof procurement<E>>;
type Callable<C> = C extends (input: infer I) => Promise<infer R> ? (input: I) => Promise<R> : never;
export type StudyCommands<E = StorageError> = { [G in keyof Tables<E>]: { [K in keyof Tables<E>[G]]: Callable<Tables<E>[G][K]> } };
export type StudyFactory = (repository: ProcurementRepository, actor: Actor, policy: Policy) => StudyCommands;
