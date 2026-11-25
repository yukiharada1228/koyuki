import test from 'node:test';
import assert from 'node:assert/strict';
import { business, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const permission: unique symbol;
type Permitted = Readonly<{ [permission]: true }>;
type Base = Readonly<{ actor: Readonly<{ role: 'manager' | 'employee' }> }>;
// This private proof constructor trusts only this domain's successful check.
// It preserves the actual context, including opaque objects; no mutation or clone.
function permit<T extends Base>(value: T): Result<T & Permitted, 'Denied'> {
  return value.actor.role === 'manager' ? ok(value as T & Permitted) : err('Denied');
}
type Input = Readonly<{ id: string; reason: string }>;
class Context {
  #host = 'trusted';
  constructor(readonly input: Input, readonly actor: Base['actor']) {}
  host() { return this.#host; }
}
type Decision = Readonly<{ id: string; reason: string; host: string }>;
const reject = (value: Context & Permitted): Result<Decision, 'ReasonRequired'> => value.input.reason.trim()
  ? ok({ id: value.input.id, reason: value.input.reason.trim(), host: value.host() }) : err('ReasonRequired');

test('a generic proof-producing check retains the concrete context and requires the proof at the next stage', async () => {
  let loaded: Context | undefined;
  const seen: unknown[] = [];
  const app = business({ name: 'generic.proof',
    load: async (input: Input) => { loaded = new Context(input, { role: input.id === 'denied' ? 'employee' : 'manager' }); return ok(loaded); },
    operations: { reject: [permit, (value: Context & Permitted) => { seen.push(value); return reject(value); }] },
    save: async <T extends Decision>(value: T): Promise<Result<T, 'SaveFailed'>> => { seen.push('save'); return ok(value); },
  });
  type In = Assert<Equal<Parameters<typeof app.reject>[0], Input>>;
  type Out = Assert<Equal<Awaited<ReturnType<typeof app.reject>>, Result<Decision, 'Denied' | 'ReasonRequired' | 'SaveFailed'>>>;
  assert.deepEqual(await app.reject({ id: 'one', reason: ' policy ' }), ok({ id: 'one', reason: 'policy', host: 'trusted' }));
  assert.strictEqual(seen[0], loaded); assert.deepEqual(seen.slice(1), ['save']); seen.length = 0;
  const denied = await app.reject.runDetailed({ id: 'denied', reason: 'policy' });
  assert.deepEqual(denied.result, err('Denied')); assert.deepEqual(seen, []);
  assert.deepEqual(denied.trace.map(item => [item.step, item.status]), [['generic.proof.reject:load', 'ok'], ['run:1', 'error']]);
  assert.deepEqual(await app.reject({ id: 'one', reason: ' ' }), err('ReasonRequired'));
  assert.equal(seen.length, 1); assert.strictEqual(seen[0], loaded);
});

function typeContracts() {
  const load = async (input: Input) => ok(new Context(input, { role: 'manager' }));
  const save = async (value: Decision) => ok(value);
  // @ts-expect-error omitting permission verification cannot create the private proof
  business({ name: 'missing', load, save, operations: { reject: [reject] } });
  const broad = (value: Base): Result<Base & Permitted, 'Denied'> => permit(value);
  // @ts-expect-error a broad monomorphic proof result does not promise input or class identity
  business({ name: 'broad', load, save, operations: { reject: [broad, reject] } });
  const unrelated = <T extends Base>(value: T): Result<Permitted, 'Denied'> => permit(value);
  // @ts-expect-error producing just a proof does not preserve the context
  business({ name: 'proof-only', load, save, operations: { reject: [unrelated, reject] } });
}
void typeContracts;

test('a final proof-producing check retains class identity and a structurally equivalent public result', async () => {
  const context = new Context({ id: 'one', reason: 'policy' }, { role: 'manager' });
  const app = business({ name: 'generic.final-proof', load: async (input: Input) => { assert.strictEqual(input, context.input); return ok(context); },
    operations: { check: [permit] },
    save: async <T extends Context & Permitted>(value: T): Promise<Result<T, 'SaveFailed'>> => ok(value),
  });
  type Actual = Awaited<ReturnType<typeof app.check>>;
  type Expected = Result<Context & Permitted, 'Denied' | 'SaveFailed'>;
  // Intersections can retain redundant structural constraints. Verify both ways,
  // plus the actual fields, rather than pretending every alias is textually equal.
  type Forward = Assert<Actual extends Expected ? true : false>;
  type Backward = Assert<Expected extends Actual ? true : false>;
  const result = await app.check(context.input);
  assert(result.ok); assert.strictEqual(result.value, context); assert.equal(result.value.host(), 'trusted');
  type InputField = Assert<Equal<typeof result.value.input, Input>>;
  type ProofField = Assert<Equal<(typeof result.value)[typeof permission], true>>;
});
