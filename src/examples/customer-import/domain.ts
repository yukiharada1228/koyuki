import { ok, err, type Result } from '../../framework/index.js';

declare const visitorProof: unique symbol;
export type Input = Readonly<{ groupId: string; visitor: unknown }>;
export type Visitor = Readonly<{ name: string; email: string }> & { readonly [visitorProof]: true };
export type Validated = Readonly<{ groupId: string; visitor: Visitor }>;
export type InvalidVisitor = Readonly<{ kind: 'InvalidVisitor' }>;
export type Customer = Readonly<{ id: string; groupId: string; name: string; email: string; version: number }>;
export type Identified = Readonly<{ kind: 'identified'; request: Validated; customer: Customer }>;
export type NotIdentified = Readonly<{ kind: 'not-identified'; request: Validated; newId: string }>;
export type Identification = Identified | NotIdentified;
export type Created = Readonly<{ kind: 'created'; customer: Customer }>;
export type Updated = Readonly<{ kind: 'updated'; customer: Customer; expectedVersion: number }>;
export type Unchanged = Readonly<{ kind: 'unchanged'; customer: Customer }>;
export type Decision = Created | Updated | Unchanged;
export type IdentityMismatch = Readonly<{ kind: 'IdentityMismatch' }>;

export function validate(input: Input): Result<Validated, InvalidVisitor> {
  if (!input.groupId.trim() || typeof input.visitor !== 'object' || input.visitor === null) return err({ kind: 'InvalidVisitor' });
  const visitor = input.visitor as Record<string, unknown>;
  if (typeof visitor.name !== 'string' || !visitor.name.trim() || typeof visitor.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitor.email)) return err({ kind: 'InvalidVisitor' });
  return ok({ groupId: input.groupId, visitor: Object.freeze({ name: visitor.name.trim(), email: visitor.email.toLowerCase() }) as Visitor });
}
export function createCustomer(input: NotIdentified): Result<Created, IdentityMismatch> {
  if (!input.newId) return err({ kind: 'IdentityMismatch' });
  return ok({ kind: 'created', customer: { id: input.newId, groupId: input.request.groupId, ...input.request.visitor, version: 1 } });
}
export function updateCustomer(input: Identified): Result<Updated | Unchanged, IdentityMismatch> {
  const { customer, request } = input;
  if (customer.groupId !== request.groupId || customer.email !== request.visitor.email || !customer.id || !Number.isSafeInteger(customer.version) || customer.version < 1 || customer.version >= Number.MAX_SAFE_INTEGER) return err({ kind: 'IdentityMismatch' });
  return customer.name === request.visitor.name
    ? ok({ kind: 'unchanged', customer })
    : ok({ kind: 'updated', customer: { ...customer, name: request.visitor.name, version: customer.version + 1 }, expectedVersion: customer.version });
}
export function decide(input: Identification): Result<Decision, IdentityMismatch> {
  switch (input.kind) {
    case 'identified': return updateCustomer(input);
    case 'not-identified': return createCustomer(input);
    default: return assertNever(input);
  }
}
function assertNever(value: never): never { throw new Error('UnknownIdentification'); }
