import { defineUseCaseGroup, step, ok, type GroupExecution } from 'koyuki';
const transition = { validate: step('validate', (n: number) => ok(n)), require: [] as const, evolve: step('evolve', (n: number) => ok(n)) };
const group = defineUseCaseGroup({ operation: (name: 'add') => name, save: async (n: number, _execution: GroupExecution<'add', number>) => ok(n) });
group.on('missing', { load: async (n: number) => ok(n), transition });
group.on('add', { load: async (n: string) => ok(n.length), transition });
group.on('add', { load: async (n: number) => ok(String(n)), transition });
group.on('add', { load: async (n: number) => ok(n), transition: { ...transition, evolve: step('bad', (n: number) => ok(String(n))) } });
group.on('add', { load: async (n: number) => ok(n), transition: { ...transition, require: [step('bad', (n: string) => ok(n))] as const } });
defineUseCaseGroup({ operation: (name: 'add') => name, save: async (n: number, _execution: GroupExecution<'add', number>) => ok(n), replay: { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: [] } });
