import { ok, err, type Result } from '../framework/index.js';
export type Registration = Readonly<{ id: string; email: string } & (
  { kind: 'awaiting'; version: 1; tokenDigest: string } | { kind: 'confirmed'; version: 2; confirmedAt: number }
)>;
export interface EmailRequested { readonly type: 'EmailRequested'; readonly id: string; readonly registrationId: string; readonly email: string; readonly token: string }
export type RuleError = { kind: 'InvalidInput' } | { kind: 'AlreadyRegistered' } | { kind: 'InvalidConfirmation' };
export interface StartInput { readonly id: string; readonly email: string; readonly token: string; readonly tokenDigest: string }
export interface ConfirmInput { readonly id: string; readonly tokenDigest: string; readonly now: number }
export interface Loaded<I> { readonly current: Registration | null; readonly input: I }
declare const proof: unique symbol;
type ValidStart = Loaded<StartInput> & { readonly [proof]: 'start' };
type ValidConfirm = { readonly current: Extract<Registration, { kind: 'awaiting' }>; readonly input: ConfirmInput; readonly [proof]: 'confirm' };
export type Change = Readonly<
  { expectedVersion: 0; next: Extract<Registration, { kind: 'awaiting' }>; event: EmailRequested } |
  { expectedVersion: 1; next: Extract<Registration, { kind: 'confirmed' }>; event: null }
> & { readonly [proof]: 'change' };
type StartChange = Extract<Change, { readonly expectedVersion: 0 }>;
type ConfirmationChange = Extract<Change, { readonly expectedVersion: 1 }>;
export function validateStart(value: Loaded<StartInput>): Result<ValidStart, RuleError> {
  const { id, email, token, tokenDigest } = value.input;
  if (!id.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !token || !/^[a-f0-9]{64}$/.test(tokenDigest)) return err({ kind: 'InvalidInput' });
  return value.current ? err({ kind: 'AlreadyRegistered' }) : ok(value as ValidStart);
}
export function start(value: ValidStart): Result<StartChange, never> {
  const { id, email, token, tokenDigest } = value.input;
  return ok({ expectedVersion: 0, next: { id, email, version: 1, kind: 'awaiting', tokenDigest },
    event: { type: 'EmailRequested', id: `${id}:email:1`, registrationId: id, email, token } } as StartChange);
}
export function validateConfirm(value: Loaded<ConfirmInput>): Result<ValidConfirm, RuleError> {
  const { current, input } = value;
  if (!Number.isSafeInteger(input.now) || input.now < 0) return err({ kind: 'InvalidInput' });
  return current?.kind === 'awaiting' && current.tokenDigest === input.tokenDigest
    ? ok({ current, input } as ValidConfirm) : err({ kind: 'InvalidConfirmation' });
}
export function confirm({ current, input }: ValidConfirm): Result<ConfirmationChange, never> {
  return ok({ expectedVersion: current.version, next: { id: current.id, email: current.email, version: 2, kind: 'confirmed', confirmedAt: input.now }, event: null } as ConfirmationChange);
}
export function restore(value: unknown): Result<Registration, { kind: 'CorruptRegistration' }> {
  const fail = () => err({ kind: 'CorruptRegistration' as const });
  if (!value || typeof value !== 'object') return fail();
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim() || typeof v.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return fail();
  if (v.kind === 'awaiting' && v.version === 1 && typeof v.tokenDigest === 'string' && /^[a-f0-9]{64}$/.test(v.tokenDigest))
    return ok({ id: v.id, email: v.email, version: 1, kind: 'awaiting', tokenDigest: v.tokenDigest });
  if (v.kind === 'confirmed' && v.version === 2 && typeof v.confirmedAt === 'number' && Number.isSafeInteger(v.confirmedAt) && v.confirmedAt >= 0)
    return ok({ id: v.id, email: v.email, version: 2, kind: 'confirmed', confirmedAt: v.confirmedAt });
  return fail();
}
