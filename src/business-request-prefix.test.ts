import test from 'node:test';
import assert from 'node:assert/strict';
import { business, withInput, step, ok, err, type Result } from './framework/index.js';
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true> = T;
type Base = Readonly<{ id: string }>;
type Request = Base & Readonly<{ reason: string; raw: unknown }>;
type Context<I> = Readonly<{ input: I; actor: string; state: 'draft' | 'closed' }>;
const verified: unique symbol = Symbol('verified');
type Verified = Readonly<{ [verified]: true }>;
const proof: Verified = { [verified]: true };
type Ready = Context<Request> & Verified & Readonly<{ state: 'draft' }>;
type Finished = Readonly<{ id: string; reason: string; amount: number }>;
function fixture(state: Context<Base>['state'] = 'draft') {
  const calls: string[] = [];
  const load = async <I extends Base>(input: I): Promise<Result<Context<I>, 'LoadFailed'>> => {
    calls.push('load'); return ok({ input, actor: 'host', state });
  };
  const common = <T extends Context<Base>>(value: T): Result<T & Verified, 'Denied'> => {
    calls.push('common'); return value.actor ? ok({ ...value, ...proof }) : err('Denied');
  };
  const ready = (value: Context<Request> & Verified): Result<Ready, 'WrongState'> => {
    calls.push('ready'); return value.state === 'draft' ? ok({ ...value, state: 'draft' }) : err('WrongState');
  };
  const parse = <T extends { readonly input: { readonly raw: unknown } }>(value: T): Result<number, 'InvalidAmount'> => {
    calls.push('parse'); return typeof value.input.raw === 'number' ? ok(value.input.raw) : err('InvalidAmount');
  };
  const parsed = withInput(parse);
  const finish = ({ input, value }: Readonly<{ input: Ready; value: number }>): Result<Finished, never> => {
    calls.push('finish'); return ok({ id: input.input.id, reason: input.input.reason, amount: value });
  };
  const save = async (value: Finished): Promise<Result<Finished, 'SaveFailed'>> => { calls.push('save'); return ok(value); };
  const app = business({ name: 'request-prefix', load, save, operations: {
    finish: [common, ready, step('parse', parsed), finish],
  } });
  return { app, calls, load, common, save };
}
test('a request prefix excludes the nested context carried by a later input/value pair', async () => {
  const { app, calls } = fixture();
  type Input = Assert<Equal<Parameters<typeof app.finish>[0], Request>>;
  type Output = Assert<Equal<Awaited<ReturnType<typeof app.finish>>, Result<Finished,'LoadFailed'|'Denied'|'WrongState'|'InvalidAmount'|'SaveFailed'>>>;
  assert.deepEqual(calls, []);
  assert.deepEqual(await app.finish({ id: 'one', reason: 'policy', raw: 3 }), ok({ id: 'one', reason: 'policy', amount: 3 }));
  assert.deepEqual(calls, ['load','common','ready','parse','finish','save']);
  if (false) {
    // @ts-expect-error unknown is the value type, not permission to omit the raw property.
    void app.finish({ id: 'one', reason: 'policy' });
    // @ts-expect-error Host context is not part of the public request.
    void app.finish({ id: 'one', reason: 'policy', raw: 3, actor: 'host' });
  }
});
test('prefix inference preserves state and parsing refusal priority without saving', async () => {
  for (const [state, raw, error, expected] of [
    ['closed', 'bad', 'WrongState', ['load','common','ready']],
    ['draft', 'bad', 'InvalidAmount', ['load','common','ready','parse']],
  ] as const) {
    const { app, calls } = fixture(state);
    const detail = await app.finish.runDetailed({ id: 'one', reason: 'policy', raw });
    assert.deepEqual(detail.result, err(error)); assert.deepEqual(calls, expected);
    assert.equal(detail.trace.at(-1)?.status, 'error');
  }
});
test('a bounded generic named requirement can introduce the operation request', async () => {
  const f = fixture();
  const calculate = <T extends Context<Request> & Verified>(value: T): Result<number,'InvalidAmount'> =>
    typeof value.input.raw === 'number' ? ok(value.input.raw) : err('InvalidAmount');
  const calculated = withInput(calculate);
  const finish = ({ input, value }: Readonly<{ input: Context<Request> & Verified; value: number }>) =>
    ok({ id: input.input.id, reason: input.input.reason, amount: value });
  const app = business({ name: 'generic-prefix', load: f.load, save: f.save, operations: {
    finish: [f.common, step('calculate', calculated), finish],
  } });
  type Input = Assert<Equal<Parameters<typeof app.finish>[0], Request>>;
  assert.deepEqual(await app.finish({ id: 'one', reason: 'policy', raw: 3 }), ok({ id: 'one', reason: 'policy', amount: 3 }));
});
class AuthorizedContext {
  #proof = true;
  constructor(readonly input: Request, readonly actor: string, readonly state: 'draft' | 'closed') {}
}
function refusals() {
  const f = fixture();
  // Every refusal below already receives the complete operation request.
  const load = <I extends Request>(input: I) => f.load(input);
  const result: Finished = { id: 'one', reason: 'policy', amount: 3 };
  const nominal = (_value: AuthorizedContext & Verified) => ok(result);
  // @ts-expect-error A structural context cannot acquire a class's private authorization.
  business({ name: 'nominal-prefix', load, save: f.save, operations: { run: [f.common, nominal] } });
  const callable = (_value: Context<Request> & Verified & (()=>void)) => ok(result);
  // @ts-expect-error Checking object fields cannot invent a required call signature.
  business({ name: 'callable-prefix', load, save: f.save, operations: { run: [f.common, callable] } });
  type Correlated = (Context<Request> & Verified & { state: 'draft'; approval: string }) | (Context<Request> & Verified & { state: 'closed'; rejection: string });
  const correlated = (_value: Correlated) => ok(result);
  // @ts-expect-error A union's common fields do not supply either variant's required facts.
  business({ name: 'union-prefix', load, save: f.save, operations: { run: [f.common, correlated] } });
  const overlapping = (_value: Context<Request> & Verified & ({ approval: string } | { rejection: string })) => ok(result);
  // @ts-expect-error Overlapping union members still require one complete set of facts.
  business({ name: 'overlapping-prefix', load, save: f.save, operations: { run: [f.common, overlapping] } });
  const optionalLoad = async <I extends Request>(input: I): Promise<Result<Context<I> & { note?: string },never>> => ok({ input, actor: 'host', state: 'draft' });
  const required = (_value: Context<Request> & Verified & { note: string | undefined }) => ok(result);
  // @ts-expect-error A value type containing undefined does not make a required property optional.
  business({ name: 'optional-prefix', load: optionalLoad, save: f.save, operations: { run: [f.common, required] } });
  const empty = (_value: {}) => ok(result);
  const discard = (_value: Context<Request> & Verified) => ok(null);
  // @ts-expect-error An empty object contract still rejects null.
  business({ name: 'null-prefix', load, save: f.save, operations: { run: [f.common, discard, empty] } });
}
void refusals;
