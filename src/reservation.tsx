import { h, Operation, Sequence, ok, err, compose, type Result, type Plan } from './core.js';
export type Raw = { kind: 'raw'; id: string; seats: number };
export type Validated = { kind: 'validated'; id: string; seats: number };
export type Checked = { kind: 'checked'; id: string; seats: number; version: number; remaining: number };
export type Candidate = { kind: 'candidate'; id: string; seats: number; version: number };
export type Saved = { kind: 'saved'; id: string; seats: number; receipt: string };
export type State = Raw | Validated | Checked | Candidate | Saved | { kind: 'rejected'; id: string; reason: DomainError };
export type DomainError = 'InvalidPartySize' | 'Full';
export type SaveError = 'Conflict';
export function validate(input: Raw): Result<Validated, 'InvalidPartySize'> {
  return Number.isSafeInteger(input.seats) && input.seats > 0
    ? ok({ ...input, kind: 'validated' }) : err('InvalidPartySize');
}
export function confirm(input: Checked): Result<Candidate, 'Full'> {
  return input.seats <= input.remaining
    ? ok({ kind: 'candidate', id: input.id, seats: input.seats, version: input.version }) : err('Full');
}
export class Store {
  version = 0;
  remaining = 1;
  readonly reservations = new Map<string, Saved>();
  readonly outbox = new Map<string, { id: string; sent: boolean }>();
  read(input: Validated): Checked {
    return { ...input, kind: 'checked', version: this.version, remaining: this.remaining };
  }
  commit(candidate: Candidate): Result<Saved, SaveError> {
    // Synchronous critical section simulates an atomic DB transaction, not a real DB.
    const existing = this.reservations.get(candidate.id);
    if (existing) {
      if (existing.seats !== candidate.seats) throw new Error('IdempotencyPayloadMismatch');
      return ok(existing);
    }
    if (candidate.version !== this.version || candidate.seats > this.remaining) return err('Conflict');
    const saved: Saved = { kind: 'saved', id: candidate.id, seats: candidate.seats, receipt: `receipt:${candidate.id}` };
    this.remaining -= candidate.seats;
    this.version++;
    this.reservations.set(candidate.id, saved);
    this.outbox.set(candidate.id, { id: candidate.id, sent: false });
    return ok(saved);
  }
}
export class Mailer {
  readonly deliveries: string[] = [];
  private readonly accepted = new Set<string>();
  constructor(private readonly idempotent = false) {}
  async send(id: string): Promise<void> {
    if (this.idempotent && this.accepted.has(id)) return;
    this.accepted.add(id);
    this.deliveries.push(id);
  }
}
export const prepare = compose(validate, (value: Validated) => ok(value));
export function describe(state: State, env: { store: Store; mailer: Mailer; emit: (state: State) => void }): Plan {
  switch (state.kind) {
    case 'raw': {
      const result = validate(state);
      return <Operation id={`validate:${state.id}`} payload={state} run={async () => {
        env.emit(result.ok ? result.value : { kind: 'rejected', id: state.id, reason: result.error });
      }} />;
    }
    case 'validated':
      return <Operation id={`availability:${state.id}`} payload={state} run={async () => { env.emit(env.store.read(state)); }} />;
    case 'checked': {
      const result = confirm(state);
      return <Operation id={`decide:${state.id}:${state.version}`} payload={state} run={async () => {
        env.emit(result.ok ? result.value : { kind: 'rejected', id: state.id, reason: result.error });
      }} />;
    }
    case 'candidate':
      return <Operation id={`save:${state.id}`} payload={state} run={async () => {
        const result = env.store.commit(state);
        if (!result.ok) throw new Error(result.error); // Execution conflict, not business rejection.
        env.emit(result.value);
      }} />;
    case 'saved':
      return <Operation id={`email:${state.id}`} payload={state} run={async () => { await env.mailer.send(state.id); }} />;
    case 'rejected': return <Sequence children={[]} />;
  }
}
