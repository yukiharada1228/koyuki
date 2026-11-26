import { business, workflow, withInput, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
class Context {
  #host = 'trusted';
  constructor(readonly amount: number, readonly currency: string) {}
  host() { return this.#host; }
}
function quote<T extends Base>(input: T): Result<number, 'Declined'> { return input.amount > 0 ? ok(input.amount * 2) : err('Declined'); }
function currency(input: Context): Result<Context, 'UnsupportedCurrency'> { return input.currency === 'JPY' ? ok(input) : err('UnsupportedCurrency'); }
const quoted = withInput(quote);
const flow = workflow('currency', currency).then('quote', quoted)
  .then('finish', pair => ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`));
const app = business({ name: 'contextual', load: async (amount: number) => ok(new Context(amount, 'JPY')),
  save: async (value: string) => ok(value), operations: { quote: [flow] },
});
type Input = Assert<Equal<Parameters<typeof app.quote>[0], number>>;
type Output = Assert<Equal<Awaited<ReturnType<typeof app.quote>>, Result<string, 'Declined' | 'UnsupportedCurrency'>>>;
