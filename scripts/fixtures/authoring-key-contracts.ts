import { operationKey, createApplication } from 'koyuki/experimental';
import { ok, err, type Result } from 'koyuki';
const key = operationKey('contract', () => ({
  run: async (_input: Readonly<{ id: string }>): Promise<Result<number, 'Unavailable'>> => ok(1),
  runDetailed: async (_input: Readonly<{ id: string }>) => ({ result: ok(1), trace: [], plan: null }),
}));
declare const app: ReturnType<typeof createApplication>;
const result = app.dispatch(key, { id: 'one' });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof result, Promise<Result<number, 'Unavailable'>>> = true;
void exact;
// @ts-expect-error Inferred key input must not widen to accommodate the caller.
void app.dispatch(key, { id: 1 });
// @ts-expect-error Required input must remain required.
void app.dispatch(key, {});
// @ts-expect-error Detailed input must accept the run input.
operationKey('wrong-input', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: number) => ({ result: ok(1), trace: [], plan: null }) }));
// @ts-expect-error Detailed success must agree with run success.
operationKey('wrong-output', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: string) => ({ result: ok('wrong'), trace: [], plan: null }) }));
// @ts-expect-error Detailed error cannot expand the run error union.
operationKey('wrong-error', () => ({ run: async (_input: string): Promise<Result<number, 'Expected'>> => ok(1), runDetailed: async (_input: string) => ({ result: err<'Unexpected'>('Unexpected'), trace: [], plan: null }) }));
// @ts-expect-error Key creation takes a synchronous custom Hook, not an async factory.
operationKey('async-hook', async () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: string) => ({ result: ok(1), trace: [], plan: null }) }));
