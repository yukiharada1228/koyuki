// Compile-time contracts for the unpublished ordinary-function API study.
import { business } from './experiments/business.js';
import { type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
declare const validated: unique symbol;
declare const authorized: unique symbol;
type Request = { id: string };
type Validated = Request & { readonly [validated]: true };
type Authorized = Validated & { readonly [authorized]: true };
type Approved = { status: 'approved'; id: string };
declare const load: (input: Request) => Promise<Result<Request, 'NotFound'>>;
declare const validate: (value: Request) => Result<Validated, 'Invalid'>;
declare const permit: (value: Validated) => Result<Authorized, 'Forbidden'>;
declare const approve: (value: Authorized) => Result<Approved, 'Closed'>;
declare const misleadingDiagnostic: typeof approve & { readonly 'Koyuki: approve[1] input must accept prior output': never };
declare const save: (value: Approved) => Promise<Result<Approved, 'Conflict'>>;
// Never called: declared proof constructors are intentionally type-only.
function contracts() {
  const expense = business({ name: 'proof', load, save, operations: { approve: [validate, permit, approve] } });
  type Input = Parameters<typeof expense.approve>[0];
  type Output = Awaited<ReturnType<typeof expense.approve>>;
  type InputExact = Assert<Equal<Input, Request>>;
  type OutputExact = Assert<Equal<Output, Result<Approved, 'NotFound' | 'Invalid' | 'Forbidden' | 'Closed' | 'Conflict'>>>;
  type NoAny = Assert<Equal<IsAny<Output>, false>>;
  business({ name: 'stable', load, save, operation: name => {
    const exact: 'approve' = name;
    // @ts-expect-error the resolver must not widen the known operation keys
    const wrong: 'submit' = name;
    return `expense.${exact}.v1`;
  }, operations: { approve: [validate, permit, approve] } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error validation alone does not provide authorization proof
    approve: [validate, approve],
  } });
  // @ts-expect-error permission needs validated input before it can produce authorization
  business({ name: 'bad', load, save, operations: { approve: [permit, validate, approve] } });
  const decoratedWrong = Object.assign(approve, { 'Koyuki: approve[1] input must accept prior output': undefined });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error a diagnostic-looking property cannot replace the missing authorization proof
    approve: [validate, decoratedWrong],
  } });
  business({ name: 'bad', load, save, operations: {
    // @ts-expect-error even an exact diagnostic marker must still satisfy the actual function input contract
    approve: [validate, misleadingDiagnostic],
  } });
  // Each stage has a distinct literal state; this is not a homogeneous repetition.
  type State<N extends number> = { stage: N };
  const stage = <const N extends number, const M extends number>(_before: N, after: M) =>
    (_value: State<N>): Result<State<M>, never> => ({ ok: true, value: { stage: after } });
  const longLoad = async (_input: Request): Promise<Result<State<0>, never>> => ({ ok: true, value: { stage: 0 } });
  const longSave = async (value: State<64>): Promise<Result<State<64>, never>> => ({ ok: true, value });

  const long = business({ name: 'long', load: longLoad, save: longSave, operations: {
    advance: [
    stage(0, 1), stage(1, 2), stage(2, 3), stage(3, 4),
    stage(4, 5), stage(5, 6), stage(6, 7), stage(7, 8),
    stage(8, 9), stage(9, 10), stage(10, 11), stage(11, 12),
    stage(12, 13), stage(13, 14), stage(14, 15), stage(15, 16),
    stage(16, 17), stage(17, 18), stage(18, 19), stage(19, 20),
    stage(20, 21), stage(21, 22), stage(22, 23), stage(23, 24),
    stage(24, 25), stage(25, 26), stage(26, 27), stage(27, 28),
    stage(28, 29), stage(29, 30), stage(30, 31), stage(31, 32),
    stage(32, 33), stage(33, 34), stage(34, 35), stage(35, 36),
    stage(36, 37), stage(37, 38), stage(38, 39), stage(39, 40),
    stage(40, 41), stage(41, 42), stage(42, 43), stage(43, 44),
    stage(44, 45), stage(45, 46), stage(46, 47), stage(47, 48),
    stage(48, 49), stage(49, 50), stage(50, 51), stage(51, 52),
    stage(52, 53), stage(53, 54), stage(54, 55), stage(55, 56),
    stage(56, 57), stage(57, 58), stage(58, 59), stage(59, 60),
    stage(60, 61), stage(61, 62), stage(62, 63), stage(63, 64),
  ],
  } });

  const custom = business({ name: 'custom-long', load, save: longSave, operations: {
    advance: { load: longLoad, run: [
    stage(0, 1), stage(1, 2), stage(2, 3), stage(3, 4),
    stage(4, 5), stage(5, 6), stage(6, 7), stage(7, 8),
    stage(8, 9), stage(9, 10), stage(10, 11), stage(11, 12),
    stage(12, 13), stage(13, 14), stage(14, 15), stage(15, 16),
    stage(16, 17), stage(17, 18), stage(18, 19), stage(19, 20),
    stage(20, 21), stage(21, 22), stage(22, 23), stage(23, 24),
    stage(24, 25), stage(25, 26), stage(26, 27), stage(27, 28),
    stage(28, 29), stage(29, 30), stage(30, 31), stage(31, 32),
    stage(32, 33), stage(33, 34), stage(34, 35), stage(35, 36),
    stage(36, 37), stage(37, 38), stage(38, 39), stage(39, 40),
    stage(40, 41), stage(41, 42), stage(42, 43), stage(43, 44),
    stage(44, 45), stage(45, 46), stage(46, 47), stage(47, 48),
    stage(48, 49), stage(49, 50), stage(50, 51), stage(51, 52),
    stage(52, 53), stage(53, 54), stage(54, 55), stage(55, 56),
    stage(56, 57), stage(57, 58), stage(58, 59), stage(59, 60),
    stage(60, 61), stage(61, 62), stage(62, 63), stage(63, 64),
  ] },
  } });
  type CustomInput = Assert<Equal<Parameters<typeof custom.advance>[0], Request>>;
  type CustomOutput = Assert<Equal<Awaited<ReturnType<typeof custom.advance>>, Result<State<64>, never>>>;
  type LongOutput = Assert<Equal<Awaited<ReturnType<typeof long.advance>>, Result<State<64>, never>>>;

  business({ name: 'broken', load: longLoad, save: longSave, operations: {
    advance: [
    stage(0, 1), stage(1, 2), stage(2, 3), stage(3, 4),
    stage(4, 5), stage(5, 6), stage(6, 7), stage(7, 8),
    stage(8, 9), stage(9, 10), stage(10, 11), stage(11, 12),
    stage(12, 13), stage(13, 14), stage(14, 15), stage(15, 16),
    stage(16, 17), stage(17, 18), stage(18, 19), stage(19, 20),
    stage(20, 21), stage(21, 22), stage(22, 23), stage(23, 24),
    stage(24, 25), stage(25, 26), stage(26, 27), stage(27, 28),
    stage(28, 29), stage(29, 30), stage(30, 31), stage(31, 32),
    stage(32, 33), stage(33, 34), stage(34, 35), stage(35, 36),
    stage(36, 37), stage(37, 38), stage(38, 39), stage(39, 40),
    stage(40, 41), stage(41, 42), stage(42, 43), stage(43, 44),
    stage(44, 45), stage(45, 46), stage(46, 47), stage(47, 48),
    stage(48, 49), stage(49, 50), stage(50, 51), stage(51, 52),
    stage(52, 53), stage(53, 54), stage(54, 55),
    // @ts-expect-error these adjacent stages disagree, whether diagnosed at producer or consumer
    stage(55, 56), stage(55, 57), stage(57, 58), stage(58, 59), stage(59, 60),
    stage(60, 61), stage(61, 62), stage(62, 63), stage(63, 64),
  ],
  } });
}
void contracts;
