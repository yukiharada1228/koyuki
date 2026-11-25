// Deliberately contains a failing inline example. No Koyuki imports or Result types.
type Fn = (input: never) => unknown;
type Last<A, T extends readonly Fn[]> = T extends readonly [...Fn[], infer F extends Fn] ? ReturnType<F> : A;
declare function declare<A, const T extends readonly Fn[] = readonly [], O = unknown>(definition: {
  validate: (n: number) => A;
  require?: T;
  evolve: (value: NoInfer<Last<A, T>>) => O;
}): O;
function carry<I, O>(fn: (input: I) => O): (input: I) => { input: I; value: O } {
  return input => ({ input, value: fn(input) });
}
const quote = (n: number) => n * 2;
const named = carry(quote);
const pass = declare({ validate: (n: number) => n, require: [named], evolve: p => p.input + p.value });
const direct = declare({ validate: (n: number) => n, require: [(n: number) => ({ input: n, value: n * 2 })], evolve: p => p.input + p.value });
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactNamed: Equal<typeof pass, number> = true;
const exactDirect: Equal<typeof direct, number> = true;
void exactNamed; void exactDirect;
// Inline reproduction
const inline = declare({ validate: (n: number) => n, require: [carry(quote)], evolve: p => p.input + p.value });
const exactInline: Equal<typeof inline, number> = true;
void exactInline;
