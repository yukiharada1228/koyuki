/** @jsx h */
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, createContext, useContext, defineOperation, Operation, createApplication } from './framework/authoring.js';
import { workflow, ok, err, type Result, type Execution, type Receipt, type ReplayInputError, type ReplayReport } from './framework/index.js';
import type { ActionReport } from './framework/action.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const InputContext = createContext<number>();
type Input = Readonly<{ amount: number }>;
test('a custom Hook supplies the complete plain operation contract without evaluating the Hook', async () => {
  let hooks = 0, loads = 0, saves = 0;
  const price = defineOperation('price', () => {
    hooks++;
    const tax = useContext(InputContext);
    return {
      load: async (input: Input): Promise<Result<number, 'Offline'>> => { loads++; return ok(input.amount); },
      execute: workflow('positive', (amount: number): Result<number, 'Invalid'> => amount > 0 ? ok(amount + tax) : err('Invalid')),
      save: async (amount: number): Promise<Result<string, 'SaveFailed'>> => { saves++; return ok(String(amount)); },
    };
  });
  assert.equal(hooks, 0);
  function Price() { return <Operation operation={price} />; }
  const app = createApplication(<InputContext.Provider value={2}><Price /></InputContext.Provider>);
  assert.equal(hooks, 1); assert.equal(loads, 0); assert.equal(saves, 0);
  const output = app.execute(price, { amount: 3 });
  const exact: Equal<typeof output, Promise<Result<string, 'Offline' | 'Invalid' | 'SaveFailed'>>> = true; void exact;
  assert.deepEqual(await output, ok('5'));
  const report = await app.executeDetailed(price, { amount: 0 });
  const exactReport: Equal<typeof report, ActionReport<string, 'Offline' | 'Invalid' | 'SaveFailed'>> = true; void exactReport;
  assert.deepEqual(report.result, err('Invalid')); assert.equal(saves, 1);
  if (false) {
    // @ts-expect-error Input is inferred from load, not from a dispatch argument.
    void app.execute(price, { amount: '3' });
    // @ts-expect-error The required amount field is retained.
    void app.execute(price, {});
  }
});
test('the same inferred key preserves the replay envelope and exact detailed report', async () => {
  let saved: string | undefined, saves = 0, hooks = 0;
  const price = defineOperation('saved-price', () => {
    hooks++;
    return {
      load: async (input: Input): Promise<Result<number, 'Offline'>> => ok(input.amount),
      execute: (amount: number): Result<number, 'Invalid'> => amount > 0 ? ok(amount) : err('Invalid'),
      save: async (amount: number): Promise<Result<Execution<string>, 'SaveFailed'>> => {
        saves++; saved = String(amount); return ok({ kind: 'committed', value: saved });
      },
      replay: { lookup: (_input: Input): Result<Receipt<string>, 'LookupFailed'> => ok(saved === undefined ? { kind: 'missing' } : { kind: 'found', value: saved }), resolveAfter: () => false },
    };
  });
  assert.equal(hooks, 0);
  function Price() { return <Operation operation={price} />; }
  const app = createApplication(<Price />);
  const first = await app.executeDetailed(price, { amount: 3 });
  const exact: Equal<typeof first, ReplayReport<string, 'Offline' | 'Invalid' | 'SaveFailed', 'LookupFailed'>> = true; void exact;
  assert.deepEqual(first.result, ok({ kind: 'committed', value: '3' }));
  const next = app.execute(price, { amount: 3 });
  const exactResult: Equal<typeof next, Promise<Result<Execution<string>, 'Offline' | 'Invalid' | 'SaveFailed' | 'LookupFailed' | ReplayInputError>>> = true; void exactResult;
  assert.deepEqual(await next, ok({ kind: 'replayed', value: '3' })); assert.equal(saves, 1);
});
