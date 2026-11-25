import { defineTransition, withInput, transition, ok, err, type Result } from 'koyuki';
const validate = (amount: number) => ok(amount);
const quote = (amount: number): Result<number, 'Declined'> => amount > 0 ? ok(amount * 2) : err('Declined');
// A known compiler-inference limitation, not an example to recommend to consumers.
// Keep each diagnostic local; accepting this through any/unknown is not a fix.
defineTransition({ validate,
  // @ts-expect-error inline generic requirement and unannotated evolve currently select the empty default tuple
  require: [withInput(quote)],
  // @ts-expect-error the pair is not inferred here; do not silently treat it as any
  evolve: pair => ok(pair.input + pair.value),
});
const quoted = withInput(quote);
const valid = transition(defineTransition({ validate, require: [quoted], evolve: pair => ok(pair.input + pair.value) }));
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<ReturnType<typeof valid.run>, Result<number, 'Declined'>> = true;
const input: Equal<Parameters<typeof valid.run>[0], number> = true;
void exact; void input;
