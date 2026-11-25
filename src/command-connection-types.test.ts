// Regression contracts: methods on supplied commands must not bypass strict input variance.
import { process, defineAction, withReplay, ok, type ActionReport, type Execution } from './framework/index.js';
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
