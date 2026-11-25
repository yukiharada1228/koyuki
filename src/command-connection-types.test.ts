// Regression contracts: methods on supplied commands must not bypass strict input variance.
import { process, workflow, bindMutation, defineCommand, defineAction, withReplay, ok, type ActionReport, type Execution } from './framework/index.js';
if (false) {
  const narrow = { async runDetailed(input: 'approved'): Promise<ActionReport<string, never>> {
    return { result: ok(input.toUpperCase()), trace: [], plan: null };
  } };
  // @ts-expect-error arbitrary strings can reach this operation
  process<string>().effect('narrow', narrow);
  // @ts-expect-error commit must consume every possible preceding output
  process<string>().commit(narrow);
  defineAction({ loadName: 'load', load: async () => ok('any' as string),
    // @ts-expect-error the loader has not proved that the value is approved
    mutation: narrow });
  const replayNarrow = { async runDetailed(input: 'approved'): Promise<ActionReport<Execution<string>, never>> {
    return { result: ok({ kind: 'committed', value: input }), trace: [], plan: null };
  } };
  withReplay({ run: async (input: string) => ok({ kind: 'committed' as const, value: input }),
    // @ts-expect-error runDetailed must consume the same input range as run
    runDetailed: replayNarrow.runDetailed }, { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: () => false });

  const anyString = { async runDetailed(input: string): Promise<ActionReport<string, never>> {
    return { result: ok(input), trace: [], plan: null };
  } };
  // Widening a consumer is safe. Narrowing a producer is safe too.
  process<'approved'>().effect('wide', anyString).commit(anyString);
  process<'approved'>().effect('same', narrow);
  defineAction({ loadName: 'load', load: async () => ok('approved' as const), mutation: narrow });

  type Loaded = { kind: 'pending'; id: string } | { kind: 'approved'; id: string };
  const approvedOnly = { async runDetailed(input: Extract<Loaded, { kind: 'approved' }>) {
    return { result: ok(input.id), trace: [], plan: null };
  } };
  // @ts-expect-error a union must be narrowed by a real preceding rule
  process<Loaded>().effect('approve-only', approvedOnly);
  // @ts-expect-error same rule for the final command
  process<Loaded>().commit(approvedOnly);
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const inferred = defineAction({
  loadName: 'load',
  load: async (id: number): Promise<import('./framework/index.js').Result<string, 'Missing'>> => ok(String(id)),
  mutation: { async runDetailed(input: string): Promise<ActionReport<boolean, 'Denied'>> {
    return { result: ok(input.length > 0), trace: [], plan: null };
  } },
});
type InferredInput = Assert<Equal<Parameters<typeof inferred.run>[0], number>>;
type InferredResult = Assert<Equal<Awaited<ReturnType<typeof inferred.run>>, import('./framework/index.js').Result<boolean, 'Missing' | 'Denied'>>>;
const explicit = defineAction<number, string, 'Missing', boolean, 'Denied'>({
  loadName: 'load', load: async id => ok(String(id)),
  mutation: { runDetailed: async text => ({ result: ok(text.length > 0), trace: [], plan: null }) },
});
type ExplicitInput = Assert<Equal<Parameters<typeof explicit.run>[0], number>>;

if (false) {
  const literal = workflow('one', (value: 'one') => ok(value.length));
  // @ts-expect-error aliasing cannot widen a workflow input to bypass the connection contract
  const widened: import('./framework/index.js').Workflow<string, number, never> = literal;
  void widened;
  // @ts-expect-error an explicit wider input does not prove the required literal
  bindMutation<string, number, never, number, never>({ operation: 'unsafe-binding', workflow: literal, save: async value => ok(value) });
  // @ts-expect-error arbitrary loaded strings have not been proved to be the required literal
  defineCommand({ operation: 'unsafe', load: async (_id: number) => ok('any' as string), decide: literal, save: async (value: number) => ok(value) });
  defineCommand({ operation: 'safe', load: async (_id: number) => ok('one' as const),
    decide: workflow('wide', (value: string) => ok(value.length)), save: async (value: number) => ok(value) });
}

const connected = defineCommand({ operation: 'typed-command',
  load: async (id: number): Promise<import('./framework/index.js').Result<string, 'Missing'>> => ok(String(id)),
  decide: workflow('nonempty', (value: string): import('./framework/index.js').Result<number, 'Empty'> => ok(value.length)),
  save: async (length: number): Promise<import('./framework/index.js').Result<boolean, 'Conflict'>> => ok(length > 0),
});
type CommandInput = Assert<Equal<Parameters<typeof connected.run>[0], number>>;
type CommandResult = Assert<Equal<Awaited<ReturnType<typeof connected.run>>, import('./framework/index.js').Result<boolean, 'Missing' | 'Empty' | 'Conflict'>>>;
const explicitCommand = defineCommand<number, string, 'Missing', number, 'Empty', boolean, 'Conflict'>({
  operation: 'explicit-command', load: async id => ok(String(id)),
  decide: workflow('length', (value: string) => ok(value.length)), save: async value => ok(value > 0),
});
type ExplicitCommandInput = Assert<Equal<Parameters<typeof explicitCommand.run>[0], number>>;
type ExplicitCommandResult = Assert<Equal<Awaited<ReturnType<typeof explicitCommand.run>>, import('./framework/index.js').Result<boolean, 'Missing' | 'Empty' | 'Conflict'>>>;
