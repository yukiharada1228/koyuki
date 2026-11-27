/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createContext, useContext, useOperation, Operation, operationKey, createApplication } from './framework/authoring.js';
import { workflow, ok, err, type Result, type Execution, type Receipt, type ReplayInputError, type ReplayReport } from './framework/index.js';
import type { ActionReport } from './framework/action.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const InputContext = createContext<number>();
type Input = Readonly<{ amount: number }>;
test('a custom Hook supplies the complete plain operation contract without evaluating the Hook', async () => {
  let hooks = 0, loads = 0, saves = 0;
  function usePrice() {
    hooks++;
    const tax = useContext(InputContext);
    return useOperation({ name: 'price',
      load: async (input: Input): Promise<Result<number, 'Offline'>> => { loads++; return ok(input.amount); },
      execute: workflow('positive', (amount: number): Result<number, 'Invalid'> => amount > 0 ? ok(amount + tax) : err('Invalid')),
      save: async (amount: number): Promise<Result<string, 'SaveFailed'>> => { saves++; return ok(String(amount)); },
    });
  }
  const price = operationKey('price', usePrice);
  assert.equal(hooks, 0);
  function Price() { const handler = usePrice(); return <Operation operation={price} handler={handler} />; }
  const app = createApplication(<InputContext.Provider value={2}><Price /></InputContext.Provider>);
  assert.equal(hooks, 1); assert.equal(loads, 0); assert.equal(saves, 0);
  const output = app.dispatch(price, { amount: 3 });
  const exact: Equal<typeof output, Promise<Result<string, 'Offline' | 'Invalid' | 'SaveFailed'>>> = true; void exact;
  assert.deepEqual(await output, ok('5'));
  const report = await app.inspect(price, { amount: 0 });
  const exactReport: Equal<typeof report, ActionReport<string, 'Offline' | 'Invalid' | 'SaveFailed'>> = true; void exactReport;
  assert.deepEqual(report.result, err('Invalid')); assert.equal(saves, 1);
  if (false) {
    // @ts-expect-error Input is inferred from load, not from a dispatch argument.
    void app.dispatch(price, { amount: '3' });
    // @ts-expect-error The required amount field is retained.
    void app.dispatch(price, {});
  }
});
test('the same inferred key preserves the replay envelope and exact detailed report', async () => {
  let saved: string | undefined, saves = 0, hooks = 0;
  function useSavedPrice() {
    hooks++;
    return useOperation({ name: 'saved-price',
      load: async (input: Input): Promise<Result<number, 'Offline'>> => ok(input.amount),
      execute: (amount: number): Result<number, 'Invalid'> => amount > 0 ? ok(amount) : err('Invalid'),
      save: async (amount: number): Promise<Result<Execution<string>, 'SaveFailed'>> => {
        saves++; saved = String(amount); return ok({ kind: 'committed', value: saved });
      },
      replay: { lookup: (_input: Input): Result<Receipt<string>, 'LookupFailed'> => ok(saved === undefined ? { kind: 'missing' } : { kind: 'found', value: saved }), resolveAfter: () => false },
    });
  }
  const price = operationKey('saved-price', useSavedPrice);
  assert.equal(hooks, 0);
  function Price() { const handler = useSavedPrice(); return <Operation operation={price} handler={handler} />; }
  const app = createApplication(<Price />);
  const first = await app.inspect(price, { amount: 3 });
  const exact: Equal<typeof first, ReplayReport<string, 'Offline' | 'Invalid' | 'SaveFailed', 'LookupFailed'>> = true; void exact;
  assert.deepEqual(first.result, ok({ kind: 'committed', value: '3' }));
  const next = app.dispatch(price, { amount: 3 });
  const exactResult: Equal<typeof next, Promise<Result<Execution<string>, 'Offline' | 'Invalid' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>> = true; void exactResult;
  assert.deepEqual(await next, ok({ kind: 'replayed', value: '3' })); assert.equal(saves, 1);
});

// The report may not expand the run contract to disguise an incompatible Hook.
if (false) {
  // @ts-expect-error Detailed input must accept the run input.
  operationKey('wrong-input', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: number) => ({ result: ok(1), trace: [], plan: null }) }));
  // @ts-expect-error Detailed success must agree with run success.
  operationKey('wrong-output', () => ({ run: async (_input: string) => ok(1), runDetailed: async (_input: string) => ({ result: ok('wrong'), trace: [], plan: null }) }));
  // @ts-expect-error The report cannot introduce a failure outside the run error union.
  operationKey('wrong-error', () => ({ run: async (_input: string): Promise<Result<number, 'Expected'>> => ok(1), runDetailed: async (_input: string) => ({ result: err('Unexpected'), trace: [], plan: null }) }));
}
