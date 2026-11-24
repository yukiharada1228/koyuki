import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, Sequence, compose, ok, type Plan, type Step, type Result } from './core.js';
import { validate, confirm, type Validated, type Candidate } from './reservation.js';
const acceptValidated: Step<Validated, string, 'CustomError'> = value => ok(value.id);
const composed = compose(validate, acceptValidated);
const proof: Result<string, 'InvalidPartySize' | 'CustomError'> = composed({ kind: 'raw', id: 'a', seats: 1 });
// @ts-expect-error Validated is not Checked: missing availability and version.
compose(validate, confirm);
// @ts-expect-error InvalidPartySize cannot be erased from the error union.
const lostError: Result<string, 'CustomError'> = composed({ kind: 'raw', id: 'a', seats: 1 });
function TypedStep<I, O>(props: { run: (input: I) => O }): Plan {
  return { kind: 'sequence', children: [] };
}
const first = (input: Validated): Candidate => ({ kind: 'candidate', id: input.id, seats: input.seats, version: 0 });
const incompatible = (input: { receipt: string }): string => input.receipt;
// Intentionally no @ts-expect-error here: each prop is valid individually,
// but JSX erases the input/output relationship between sibling nodes.
const acceptedButDisconnected = <Sequence>
  <TypedStep run={first} />
  <TypedStep run={incompatible} />
</Sequence>;
test('TYPE WEAKNESS: JSX accepts incompatible sibling transformations; typed compose rejects them', () => {
  assert(proof.ok); assert.equal(acceptedButDisconnected.kind, 'sequence');
});

// JSX can preserve the relationship inside one explicitly typed boundary.
function ConfirmBoundary(props: { state: Parameters<typeof confirm>[0] }): Plan {
  return { kind: 'sequence', children: [] };
}
const validated: Validated = { kind: 'validated', id: 'a', seats: 1 };
// @ts-expect-error Explicitly bound state is missing availability/version.
const rejectedBoundary = <ConfirmBoundary state={validated} />;
void rejectedBoundary;
