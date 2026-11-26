import { step, transition, defineTransition, withInput, business, ok, err, type Result } from './framework/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> { return value.amount > 0 ? ok(value.amount * 2) : err('Declined'); }
const quoted = withInput(quote);
const direct = step('direct', quote), bound = step('bound', quoted), inline = step('inline', withInput(quote));
type Input = Assert<Equal<Parameters<typeof direct.rule>[0], Base>>;
type Output = Assert<Equal<ReturnType<typeof direct.rule>, Result<number, 'Declined'>>>;
type BoundInput = Assert<Equal<Parameters<typeof bound.rule>[0], Base>>;
type BoundOutput = Assert<Equal<ReturnType<typeof bound.rule>, Result<Readonly<{ input: Base; value: number }>, 'Declined'>>>;
type InlineOutput = Assert<Equal<ReturnType<typeof inline.rule>, ReturnType<typeof bound.rule>>>;
const flow = transition(defineTransition({ validate: (value: Base) => ok(value),
  require: [step('quote', withInput(quote))], evolve: pair => ok(pair.input.amount + pair.value),
}));
type FlowInput = Assert<Equal<Parameters<typeof flow.run>[0], Base>>;
type FlowOutput = Assert<Equal<ReturnType<typeof flow.run>, Result<number, 'Declined'>>>;
const app = business({ name: 'step-generic', load: async (value: Base) => ok(value), save: async (value: number) => ok(value), operations: { calculate: [flow] } });
type AppInput = Assert<Equal<Parameters<typeof app.calculate>[0], Base>>;
type AppOutput = Assert<Equal<Awaited<ReturnType<typeof app.calculate>>, Result<number, 'Declined'>>>;
