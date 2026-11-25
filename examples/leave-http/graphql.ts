import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { buildSchema, graphql, GraphQLError } from 'graphql';
import type { Execution, Result } from 'koyuki';
import { leaveCommands, type Call } from './application.js';
import { balance, validInput, type Account, type Actor, type Input, type SubmitInput, type RuleError } from './domain.js';
import type { StorageError } from './repository.js';
import type { Authenticate, HttpRepository } from './http.js';

type Failure = RuleError | StorageError | { kind: 'ReplayInputNotCloneable' };
type FailureCode = Failure['kind'];
// One checked table drives public enum values and runtime failure serialization.
const failureCodes = {
  InvalidInput: 'InvalidInput',
  ReplayInputNotCloneable: 'ReplayInputNotCloneable',
  Forbidden: 'Forbidden',
  NotFound: 'NotFound',
  Conflict: 'Conflict',
  IdempotencyConflict: 'IdempotencyConflict',
  InvalidState: 'InvalidState',
  InsufficientDays: 'InsufficientDays',
  CorruptLeave: 'CorruptLeave',
  StorageUnavailable: 'StorageUnavailable',
} as const satisfies { [K in FailureCode]: K };
const knownFailure = (code: unknown): code is FailureCode => typeof code === 'string' && Object.hasOwn(failureCodes, code);
const schema = buildSchema(`
  enum LeaveFailureCode { ${Object.values(failureCodes).join(' ')} }
  type Balance { granted: Int! reserved: Int! used: Int! available: Int! }
  type Leave { id: ID! days: Int! kind: String! by: ID }
  type Account { employee: ID! version: Int! granted: Int! leaves: [Leave!]! balance: Balance! }
  type LeaveSuccess { kind: String! account: Account! }
  type LeaveFailure { code: LeaveFailureCode! }
  union LeaveResult = LeaveSuccess | LeaveFailure
  input ChangeInput { employee: ID! leaveId: ID! expectedVersion: Int! }
  input SubmitInput { employee: ID! leaveId: ID! expectedVersion: Int! days: Int! }
  type Query { account(employee: ID!): Account }
  type Mutation {
    submit(requestId: ID!, input: SubmitInput!): LeaveResult!
    approve(requestId: ID!, input: ChangeInput!): LeaveResult!
    withdraw(requestId: ID!, input: ChangeInput!): LeaveResult!
  }
`);
const id = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value;
const scope = (actor: Actor, employee: string) => actor.active && (actor.id === employee || actor.role === 'manager');
const present = (account: Account) => ({ ...account, balance: balance(account) });
const queryError = (code: FailureCode | 'InternalError') => {
  const safe = code === 'InternalError' || knownFailure(code) ? code : 'InternalError';
  return new GraphQLError(safe, { extensions: { code: safe } });
};
const failure = (code: FailureCode) => {
  if (!knownFailure(code)) throw queryError('InternalError');
  return { __typename: 'LeaveFailure' as const, code: failureCodes[code] };
};

/** Same commands as REST. Schema, request identity and projections belong to this adapter. */
export function createLeaveGraphql(repository: HttpRepository, authenticate: Authenticate) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.post('/graphql', bodyLimit({ maxSize: 4096, onError: c => c.json({ errors: [{ message: 'BodyTooLarge' }] }, 413) }), async c => {
    const authenticated = await authenticate(c.req.raw);
    if (!authenticated) { c.header('WWW-Authenticate', 'Bearer'); return c.json({ errors: [{ message: 'Unauthenticated' }] }, 401); }
    if (!authenticated.active) return c.json({ errors: [{ message: 'Forbidden' }] }, 403);
    const actor = Object.freeze({ ...authenticated });
    if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ errors: [{ message: 'UnsupportedMediaType' }] }, 415);
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ errors: [{ message: 'InvalidInput' }] }, 400); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ errors: [{ message: 'InvalidInput' }] }, 400);
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !['query', 'variables', 'operationName'].includes(key)) ||
        typeof body.query !== 'string' ||
        (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) ||
        (body.operationName != null && typeof body.operationName !== 'string')) return c.json({ errors: [{ message: 'InvalidInput' }] }, 400);
    const commands = leaveCommands(repository, actor);
    async function change<I extends Input>(call: Call<I>, run: (call: Call<I>) => Promise<Result<Execution<Account>, Failure>>) {
      // Scope is checked before receipt lookup, including replays of known request IDs.
      if (!id(call.requestId) || !validInput(call.input) || !id(call.input.employee) || !id(call.input.leaveId)) return failure('InvalidInput');
      if (!scope(actor, call.input.employee)) return failure('Forbidden');
      try {
        const result = await run(call);
        return result.ok ? { __typename: 'LeaveSuccess', kind: result.value.kind, account: present(result.value.value) } : failure(result.error.kind);
      } catch { throw queryError('InternalError'); }
    }
    const rootValue = {
      account: ({ employee }: { employee: string }) => {
        if (!id(employee)) throw queryError('InvalidInput');
        if (!scope(actor, employee)) throw queryError('Forbidden');
        let result;
        try { result = repository.read(employee); } catch { throw queryError('InternalError'); }
        if (!result.ok) throw queryError(result.error.kind);
        return present(result.value);
      },
      submit: (call: Call<SubmitInput>) => change(call, commands.submit.run),
      approve: (call: Call<Input>) => change(call, commands.approve.run),
      withdraw: (call: Call<Input>) => change(call, commands.withdraw.run),
    };
    const result = await graphql({ schema, source: body.query, rootValue,
      variableValues: (body.variables ?? undefined) as Record<string, unknown> | undefined,
      operationName: (body.operationName ?? undefined) as string | undefined });
    return c.json(result);
  });
  app.onError((_cause, c) => c.json({ errors: [{ message: 'InternalError' }] }, 500));
  return app;
}
