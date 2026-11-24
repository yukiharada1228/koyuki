import { defineUseCase, defineRequestTarget, ok, step } from 'koyuki';
const transition = { validate: step('number', (n: number) => ok(n)), require: [] as const, evolve: step('double', (n: number) => ok(n * 2)) };
const adapter = { operation: 'diagnostic', load: async (n: number) => ok(n), save: async (n: number) => ok(n) };
// Old: wrong save type is reported at .on.
defineRequestTarget({ ...adapter, save: async (s: string) => ok(s) }).on(transition);
// New: wrong save type is reported inside the declaration.
defineUseCase({ ...adapter, transition, save: async (s: string) => ok(s) });
// Wrong evolve input.
defineUseCase({ ...adapter, transition: { ...transition, evolve: step('wrong', (s: string) => ok(s)) } });
// Missing Execution envelope for replay.
defineUseCase({ ...adapter, transition, replay: { lookup: (_n: number) => ok({ kind: 'missing' as const }), resolveAfter: () => false } });
