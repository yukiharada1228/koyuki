import { defineTransition, withInput, transition, ok, err, type Result } from 'koyuki';
const validate = (amount: number) => ok(amount);
const quote = (amount: number): Result<number, 'Declined'> => amount > 0 ? ok(amount * 2) : err('Declined');
// Observe this valid declaration separately: a compiler improvement must be allowed.
const inline = transition(defineTransition({ validate,
  require: [withInput(quote)], // probe:require
  evolve: pair => ok(pair.input + pair.value), // probe:evolve
}));
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactInlineInput: Equal<Parameters<typeof inline.run>[0], number> = true;
const exactInlineResult: Equal<ReturnType<typeof inline.run>, Result<number, 'Declined'>> = true; // probe:exact-result
void exactInlineInput; void exactInlineResult;
const quoted = withInput(quote);
const valid = transition(defineTransition({ validate, require: [quoted], evolve: pair => ok(pair.input + pair.value) }));
const exact: Equal<ReturnType<typeof valid.run>, Result<number, 'Declined'>> = true;
const input: Equal<Parameters<typeof valid.run>[0], number> = true;
void exact; void input;
