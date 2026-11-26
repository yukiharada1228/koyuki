import { workflow, withInput, business, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
const quoted = withInput(quote);
const direct = workflow('direct', quote);
const bound = workflow('bound', quoted);
const inline = workflow('inline', withInput(quote));
type Input = Assert<Equal<Parameters<typeof direct.run>[0], Base>>;
type Direct = Assert<Equal<ReturnType<typeof direct.run>, Result<number, 'Declined'>>>;
type BoundInput = Assert<Equal<Parameters<typeof bound.run>[0], Base>>;
type Bound = Assert<Equal<ReturnType<typeof bound.run>, Result<Readonly<{ input: Base; value: number }>, 'Declined'>>>;
type Inline = Assert<Equal<ReturnType<typeof inline.run>, ReturnType<typeof bound.run>>>;
const total = bound.then('total', pair => ok(pair.input.amount + pair.value));
const app = business({ name: 'generic-first', load: async (value: Base) => ok(value), save: async (value: number) => ok(value), operations: { calculate: [total] } });
type AppInput = Assert<Equal<Parameters<typeof app.calculate>[0], Base>>;
type AppOutput = Assert<Equal<Awaited<ReturnType<typeof app.calculate>>, Result<number, 'Declined'>>>;
