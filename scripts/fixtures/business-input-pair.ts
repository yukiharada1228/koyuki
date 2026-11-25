import { business, withInput, ok, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
class Context {
  #host = 'trusted';
  constructor(readonly amount: number, readonly currency: string) {}
  host() { return this.#host; }
}
function quote<T extends Base>(input: T): Result<number, 'Declined'> { return ok(input.amount * 2); }
const quoted = withInput(quote);
type Pair = Readonly<{ input: Context; value: number }>;
type Direct = Assert<typeof quoted extends (input: Context) => Result<Pair, 'Declined'> ? true : false>;
const load = async (input: number) => ok(new Context(input, 'JPY'));
const finish = (pair: Pair) => ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`);
const save = async (value: string) => ok(value);

// Explicit concrete context: current supported workaround, without Result plumbing.
const explicitQuote = withInput((value: Context) => quote(value));
const explicit = business({ name: 'explicit', load, save,
  operations: { quote: [explicitQuote, finish] },
});
type ExplicitInput = Assert<Equal<Parameters<typeof explicit.quote>[0], number>>;
type ExplicitOutput = Assert<Equal<Awaited<ReturnType<typeof explicit.quote>>, Result<string, 'Declined'>>>;

// Direct generic withInput calls preserve Context, but business must also retain
// that correlation when calculating the intermediate stage's success type.
const inferred = business({ name: 'inferred', load, save,
  operations: { quote: [quoted, finish] },
});
type InferredInput = Assert<Equal<Parameters<typeof inferred.quote>[0], number>>;
type InferredOutput = Assert<Equal<Awaited<ReturnType<typeof inferred.quote>>, Result<string, 'Declined'>>>;
