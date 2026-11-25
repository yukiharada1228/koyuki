import type { procurement } from './application.js';
import type { StorageError, ProcurementRepository } from './repository.js';
import type { Actor, Policy } from './domain.js';
type Tables = ReturnType<typeof procurement<StorageError>>;
type Callable<C> = C extends (input: infer I) => Promise<infer R> ? (input: I) => Promise<R> : never;
export type StudyCommands = { [G in keyof Tables]: { [K in keyof Tables[G]]: Callable<Tables[G][K]> } };
export type StudyFactory = (repository: ProcurementRepository, actor: Actor, policy: Policy) => StudyCommands;
