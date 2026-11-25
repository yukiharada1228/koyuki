import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ReplayReport, Result } from 'koyuki';
import { leaveCommands } from './application.js';
import { balance, validInput, type Actor, type Account, type Input, type SubmitInput, type RuleError } from './domain.js';
import type { LeaveRepository, StorageError, Operation } from './repository.js';
export interface HttpRepository extends LeaveRepository { read(employee: string): Result<Account, StorageError> }
export type Authenticate = (request: Request) => Actor | null | Promise<Actor | null>;
type Failure = RuleError | StorageError | { kind: 'ReplayInputNotCloneable' };
type Report = ReplayReport<Account, RuleError | StorageError, StorageError>;
export interface HttpReportRecord { readonly operation: Operation; readonly requestId: string; readonly report: Report }
type Environment = { Variables: { actor: Actor } };
const statuses = {
  InvalidInput: 400, ReplayInputNotCloneable: 400, Forbidden: 403, NotFound: 404,
  Conflict: 409, IdempotencyConflict: 409, InvalidState: 409, InsufficientDays: 422,
  CorruptLeave: 503, StorageUnavailable: 503,
} as const satisfies Record<Failure['kind'], number>;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
function parseBody(body: unknown, employee: string, leaveId: string, submission: boolean): Input | SubmitInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const allowed = submission ? ['expectedVersion', 'days'] : ['expectedVersion'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) return null;
  const input = { employee, leaveId, expectedVersion: raw.expectedVersion };
  if (!validInput(input)) return null;
  if (!submission) return input;
  return typeof raw.days === 'number' && Number.isSafeInteger(raw.days) && raw.days > 0 ? { ...input, days: raw.days } : null;
}
/** Local-demo credential adapter. Production hosts can inject their session/JWT verification. */
export function bearerAuthenticator(credentials: ReadonlyMap<string, Actor>): Authenticate {
  const identities = new Map([...credentials].map(([token, actor]) => [token, Object.freeze({ ...actor })]));
  return request => {
    const header = request.headers.get('authorization');
    const token = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
    return token ? identities.get(token) ?? null : null;
  };
}
/** Stateless HTTP boundary: each command is bound to the identity of this request. */
export function createLeaveHttp(repository: HttpRepository, authenticate: Authenticate, options: {
  onReport?: (record: HttpReportRecord) => void | Promise<void>;
} = {}) {
  const app = new Hono<Environment>();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const identity = await authenticate(c.req.raw);
    if (!identity) { c.header('WWW-Authenticate', 'Bearer'); return c.json({ ok: false, error: { kind: 'Unauthenticated' } }, 401); }
    if (!identity.active) return c.json({ ok: false, error: { kind: 'Forbidden' } }, 403);
    c.set('actor', Object.freeze({ ...identity }));
    await next();
  });
  const scope: MiddlewareHandler<Environment> = async (c, next) => {
    const employee = c.req.param('employee'), leaveId = c.req.param('leaveId');
    if (!id(employee) || (leaveId !== undefined && !id(leaveId))) return c.json({ ok: false, error: { kind: 'InvalidInput' } }, 400);
    const actor = c.get('actor');
    if (actor.id !== employee && actor.role !== 'manager') return c.json({ ok: false, error: { kind: 'Forbidden' } }, 403);
    await next();
  };
  app.get('/accounts/:employee', scope, c => {
    const result = repository.read(c.req.param('employee'));
    return result.ok ? c.json({ ok: true, value: { account: result.value, balance: balance(result.value) } })
      : c.json({ ok: false, error: { kind: result.error.kind } }, statuses[result.error.kind]);
  });
  function register<I extends Input>(operation: Operation, parse: (body: unknown, employee: string, leaveId: string) => I | null,
    select: (commands: ReturnType<typeof leaveCommands>) => { runDetailed(input: { requestId: string; input: I }): Promise<Report> }) {
    app.post(`/accounts/:employee/leaves/:leaveId/${operation}`, scope,
      bodyLimit({ maxSize: 4096, onError: c => c.json({ ok: false, error: { kind: 'BodyTooLarge' } }, 413) }), async c => {
        const requestId = c.req.header('Idempotency-Key');
        if (!id(requestId)) return c.json({ ok: false, error: { kind: 'InvalidInput' } }, 400);
        if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ ok: false, error: { kind: 'UnsupportedMediaType' } }, 415);
        let body: unknown;
        try { body = await c.req.json(); } catch { return c.json({ ok: false, error: { kind: 'InvalidInput' } }, 400); }
        const input = parse(body, c.req.param('employee')!, c.req.param('leaveId')!);
        if (!input) return c.json({ ok: false, error: { kind: 'InvalidInput' } }, 400);
        const command = select(leaveCommands(repository, c.get('actor')));
        const report = await command.runDetailed({ requestId, input });
        const result = report.result;
        const response = result.ok ? c.json(result) : c.json({ ok: false, error: { kind: result.error.kind } }, statuses[result.error.kind]);
        // Observability cannot turn an already committed operation into an HTTP failure.
        try { void Promise.resolve(options.onReport?.({ operation, requestId, report })).catch(() => {}); } catch { /* observer owns its delivery guarantees */ }
        return response;
      });
  }
  register('submit', (body, employee, leaveId) => {
    const input = parseBody(body, employee, leaveId, true);
    return input && 'days' in input ? input : null;
  }, commands => commands.submit);
  register('approve', (body, employee, leaveId) => parseBody(body, employee, leaveId, false), commands => commands.approve);
  register('withdraw', (body, employee, leaveId) => parseBody(body, employee, leaveId, false), commands => commands.withdraw);
  app.notFound(c => c.json({ ok: false, error: { kind: 'NotFound' } }, 404));
  app.onError((_error, c) => c.json({ ok: false, error: { kind: 'InternalError' } }, 500));
  return app;
}
