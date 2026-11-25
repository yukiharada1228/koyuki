import { combine, ok, err, type Result } from 'koyuki';
declare const proof: unique symbol;
type Id = string & { readonly [proof]: true };
const id = (value: string): Result<Id, 'InvalidId'> => value ? ok(value as Id) : err('InvalidId');
const combined = combine([id('id'), ok(1), ok(null)]);
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exact: Equal<typeof combined, Result<readonly [Id, number, null], 'InvalidId'>> = true;
const empty: Equal<ReturnType<typeof combine<readonly []>>, Result<readonly [], never>> = true;
void exact; void empty;
if (combined.ok) {
  const value: Id = combined.value[0]; void value;
  // @ts-expect-error tuple positions must not be widened
  const wrong: Id = combined.value[1]; void wrong;
}
// @ts-expect-error constructors must already have returned Result
combine([Promise.resolve(ok(1))]);
// @ts-expect-error a bare value is not a Result
combine([ok(1), 2]);
